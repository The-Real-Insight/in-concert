/**
 * tri-bpmn-engine SDK
 * Use mode: 'rest' to talk to a running server, or mode: 'local' to bypass REST.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { emitEngineAttributionNoticeOnce } from '../attribution';
import type {
  DeployParams,
  DeployResult,
  StartInstanceParams,
  StartInstanceResult,
  InstanceSummary,
  InstanceState,
  ProcessHistoryEntry,
  CallbackItem,
  CallbackHandlers,
  EngineInitConfig,
} from './types';

export type SdkConfigRest = {
  mode: 'rest';
  baseUrl: string;
};

export type SdkConfigLocal = {
  mode: 'local';
  db: Db;
};

export type SdkConfig = SdkConfigRest | SdkConfigLocal;

export class BpmnEngineClient {
  private config: SdkConfig;
  private initHandlers: CallbackHandlers | null = null;
  private serviceVocabulary: Record<string, unknown> | null = null;
  private _onMailReceived: EngineInitConfig['onMailReceived'] | null = null;

  constructor(config: SdkConfig) {
    emitEngineAttributionNoticeOnce();
    this.config = config;
  }

  /**
   * Initialize the engine (call once at server start).
   * Registers how to process interruptions (work items, decisions) and optional service vocabulary.
   */
  init(config: EngineInitConfig): void {
    this.initHandlers = {
      onWorkItem: config.onWorkItem,
      onServiceCall: config.onServiceCall,
      onDecision: config.onDecision,
      onMultiInstanceResolve: config.onMultiInstanceResolve,
    };
    this.serviceVocabulary = config.serviceVocabulary ?? null;
    this._onMailReceived = config.onMailReceived ?? null;

    // Apply connector credentials to global config (overrides env vars)
    if (config.connectors?.['graph-mailbox']) {
      const gc = config.connectors['graph-mailbox'];
      const { config: engineConfig } = require('../config');
      if (gc.tenantId) engineConfig.graph.tenantId = gc.tenantId;
      if (gc.clientId) engineConfig.graph.clientId = gc.clientId;
      if (gc.clientSecret) engineConfig.graph.clientSecret = gc.clientSecret;
      if (gc.pollingIntervalMs != null) engineConfig.graph.pollingIntervalMs = gc.pollingIntervalMs;
      if (gc.sinceMinutes != null) engineConfig.graph.sinceMinutes = gc.sinceMinutes;
    }
  }

  /** Get the service vocabulary from init. Handlers can use this to resolve toolId → implementation. */
  getServiceVocabulary(): Record<string, unknown> | null {
    return this.serviceVocabulary;
  }

  /** Get the onMailReceived handler from init. Used by the connector worker. */
  getOnMailReceived(): EngineInitConfig['onMailReceived'] | null {
    return this._onMailReceived;
  }

  /**
   * Validate a BPMN model for executability and consistency.
   * Returns a list of problematic model elements (e.g. pools/lanes missing tri:roleId).
   * Pure function: works in both rest and local mode without server/DB.
   */
  async validateBpmn(params: { bpmnXml: string }): Promise<import('../model/validator').ValidationIssue[]> {
    const { validateBpmnXml } = await import('../model/validator');
    return validateBpmnXml(params.bpmnXml);
  }

  /**
   * Deploy a BPMN process definition.
   */
  async deploy(params: DeployParams): Promise<DeployResult> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `Deploy failed: ${res.status}`);
      }
      return (await res.json()) as DeployResult;
    }
    const { deployDefinition } = await import('../model/service');
    return deployDefinition(this.config.db, params);
  }

  /**
   * Start a new process instance.
   */
  async startInstance(params: StartInstanceParams): Promise<StartInstanceResult> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `Start failed: ${res.status}`);
      }
      return (await res.json()) as StartInstanceResult;
    }
    const { startInstance } = await import('../instance/service');
    return startInstance(this.config.db, params);
  }

  /**
   * Get instance summary (id, status, timestamps).
   */
  async getInstance(instanceId: string): Promise<InstanceSummary | null> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/instances/${instanceId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Get instance failed: ${res.status}`);
      return (await res.json()) as InstanceSummary;
    }
    const { getInstance } = await import('../instance/service');
    const result = await getInstance(this.config.db, instanceId);
    return result as InstanceSummary | null;
  }

  /**
   * Get process history / audit trail for an instance.
   * Returns entries ordered by seq (execution order).
   */
  async getProcessHistory(instanceId: string): Promise<ProcessHistoryEntry[]> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/instances/${instanceId}/history`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`Get history failed: ${res.status}`);
      const data = (await res.json()) as ProcessHistoryEntry[] | { entries?: ProcessHistoryEntry[] };
      return (Array.isArray(data) ? data : data.entries ?? []) as ProcessHistoryEntry[];
    }
    const { getProcessHistory } = await import('../history/service');
    return getProcessHistory(this.config.db, instanceId);
  }

  /**
   * Activate a worklist task (OPEN → CLAIMED). Blocks other users from activating.
   * Local mode: updates HumanTasks. REST: POST /v1/tasks/:taskId/activate.
   */
  async activateTask(
    taskId: string,
    params: { userId: string }
  ): Promise<import('../db/collections').HumanTaskDoc | null> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/tasks/${taskId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: uuidv4(), userId: params.userId }),
      });
      if (res.status === 409) throw new Error('Task already activated by another user or not OPEN');
      if (res.status === 404) throw new Error('Task not found');
      if (!res.ok) throw new Error(`Activate failed: ${res.status}`);
      return (await res.json()) as import('../db/collections').HumanTaskDoc;
    }
    const { HumanTasks } = (await import('../db/collections')).getCollections(this.config.db);
    const now = new Date();
    return HumanTasks.findOneAndUpdate(
      { _id: taskId, status: 'OPEN' },
      {
        $set: { status: 'CLAIMED', assigneeUserId: params.userId, claimedAt: now },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' }
    );
  }

  /**
   * Get a single task by id (OPEN or CLAIMED status).
   */
  async getTask(
    taskId: string
  ): Promise<import('../db/collections').HumanTaskDoc | null> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/tasks/${taskId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Get task failed: ${res.status}`);
      return (await res.json()) as import('../db/collections').HumanTaskDoc;
    }
    const { HumanTasks } = (await import('../db/collections')).getCollections(this.config.db);
    const task = await HumanTasks.findOne({
      _id: taskId,
      status: { $in: ['OPEN', 'CLAIMED'] },
    });
    return task;
  }

  /**
   * Get worklist for a user: OPEN tasks matching user's roles + CLAIMED by that user.
   * Pass userId (user._id) and roleIds from user.roleAssignments.map(ra => String(ra.role)).
   */
  async getWorklistForUser(params: {
    userId: string;
    roleIds?: string[];
  }): Promise<import('../db/collections').HumanTaskDoc[]> {
    return this.listTasks({
      userId: params.userId,
      roleIds: params.roleIds ?? [],
      limit: 100,
      sortOrder: 'asc',
    });
  }

  /**
   * List worklist tasks (human tasks). Local mode: queries HumanTasks. REST: GET /v1/tasks.
   * For worklist-for-user: pass userId + roleIds to get OPEN tasks matching roles + CLAIMED by user.
   */
  async listTasks(
    params?: import('./types').ListTasksParams
  ): Promise<import('../db/collections').HumanTaskDoc[]> {
    if (this.config.mode === 'rest') {
      const q = new URLSearchParams();
      if (params?.instanceId) q.set('instanceId', params.instanceId);
      if (params?.status) q.set('status', params.status);
      if (params?.assigneeUserId) q.set('assigneeUserId', params.assigneeUserId);
      if (params?.userId) q.set('userId', params.userId);
      if (params?.roleIds?.length) q.set('roleIds', params.roleIds.join(','));
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.sortOrder) q.set('sortOrder', params.sortOrder);
      const res = await fetch(`${this.config.baseUrl}/v1/tasks?${q}`);
      if (!res.ok) throw new Error(`List tasks failed: ${res.status}`);
      const json = (await res.json()) as { items: import('../db/collections').HumanTaskDoc[] };
      let items = json.items;
      if (params?.sortOrder === 'asc') {
        items = [...items].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      }
      return items;
    }
    const { HumanTasks } = (await import('../db/collections')).getCollections(this.config.db);
    const filter: Record<string, unknown> = {};
    if (params?.instanceId) filter.instanceId = params.instanceId;

    const uid = params?.userId;
    const rids = params?.roleIds ?? [];
    if (uid != null && rids.length > 0) {
      filter.$or = [
        { status: 'CLAIMED', assigneeUserId: uid },
        { status: 'OPEN', roleId: { $in: rids } },
        { status: 'OPEN', candidateRoleIds: { $in: rids } },
      ];
    } else if (uid != null) {
      filter.assigneeUserId = uid;
      filter.status = params?.status ?? 'CLAIMED';
    } else {
      filter.status = params?.status ?? 'OPEN';
      if (params?.assigneeUserId) filter.assigneeUserId = params.assigneeUserId;
    }

    const limit = Math.min(params?.limit ?? 100, 100);
    const sortOrder = params?.sortOrder === 'asc' ? 1 : -1;
    return HumanTasks.find(filter).sort({ createdAt: sortOrder }).limit(limit).toArray();
  }

  /**
   * Get full instance state (tokens, work items, decisions).
   */
  async getState(instanceId: string): Promise<InstanceState | null> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/instances/${instanceId}/state`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Get state failed: ${res.status}`);
      return (await res.json()) as InstanceState;
    }
    const { getCollections } = await import('../db/collections');
    const { ProcessInstanceState } = getCollections(this.config.db);
    const doc = await ProcessInstanceState.findOne(
      { _id: instanceId },
      { projection: { tokens: 1, scopes: 1, waits: 1, status: 1, version: 1 } }
    );
    return doc as InstanceState | null;
  }

  /**
   * Human completed a user task. Advances the process.
   * Pass user for completedBy/completedByDetails on HumanTask.
   */
  async completeUserTask(
    instanceId: string,
    workItemId: string,
    options?: { commandId?: string; result?: Record<string, unknown>; user?: import('./types').User }
  ): Promise<void> {
    return this.completeWorkItem(instanceId, workItemId, options);
  }

  /**
   * External system completed (e.g. async message received, long-running call returned).
   * Advances the process.
   * Pass user when a human completed it via external UI (e.g. REST API) for audit trail.
   */
  async completeExternalTask(
    instanceId: string,
    workItemId: string,
    options?: { commandId?: string; result?: Record<string, unknown>; user?: import('./types').User }
  ): Promise<void> {
    return this.completeWorkItem(instanceId, workItemId, options);
  }

  /**
   * Complete a work item (user task or service task).
   * Prefer completeUserTask or completeExternalTask for clarity.
   * Pass user for user task completion (sets completedBy, completedByDetails on HumanTask).
   */
  async completeWorkItem(
    instanceId: string,
    workItemId: string,
    options?: {
      commandId?: string;
      result?: Record<string, unknown>;
      user?: import('./types').User;
    }
  ): Promise<void> {
    const commandId = options?.commandId ?? uuidv4();
    const payload: Record<string, unknown> = { commandId, result: options?.result };
    if (options?.user) {
      payload.completedBy = options.user.email;
      payload.completedByDetails = options.user;
    }
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/instances/${instanceId}/work-items/${workItemId}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok && res.status !== 202) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `Complete failed: ${res.status}`);
      }
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { Continuations } = getCollections(this.config.db);
    const now = new Date();
    const workPayload: Record<string, unknown> = { workItemId, commandId };
    if (options?.result) workPayload.result = options.result;
    if (options?.user) {
      workPayload.completedBy = options.user.email;
      workPayload.completedByDetails = options.user;
    }
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId,
      dueAt: now,
      kind: 'WORK_COMPLETED',
      payload: workPayload,
      status: 'READY',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Submit resolved multi-instance data. Call after onMultiInstanceResolve returns { items }.
   */
  async submitMultiInstanceData(
    instanceId: string,
    params: { nodeId: string; tokenId: string; scopeId: string; items: unknown[] }
  ): Promise<void> {
    const { nodeId, tokenId, scopeId, items } = params;
    if (!Array.isArray(items)) {
      throw new Error('items must be an array');
    }
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/instances/${instanceId}/multi-instance/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId, tokenId, scopeId, items }),
        }
      );
      if (!res.ok && res.status !== 202) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `Submit multi-instance data failed: ${res.status}`);
      }
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { Continuations } = getCollections(this.config.db);
    const now = new Date();
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId,
      dueAt: now,
      kind: 'MULTI_INSTANCE_RESOLVED',
      payload: { nodeId, tokenId, scopeId, items },
      status: 'READY',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Submit a decision for an XOR gateway.
   */
  async submitDecision(
    instanceId: string,
    decisionId: string,
    options: { selectedFlowIds: string[]; commandId?: string }
  ): Promise<void> {
    const commandId = options.commandId ?? uuidv4();
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/instances/${instanceId}/decisions/${decisionId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, outcome: { selectedFlowIds: options.selectedFlowIds } }),
        }
      );
      if (!res.ok && res.status !== 202) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `Decision failed: ${res.status}`);
      }
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { Continuations } = getCollections(this.config.db);
    const now = new Date();
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId,
      dueAt: now,
      kind: 'DECISION_RECORDED',
      payload: { decisionId, selectedFlowIds: options.selectedFlowIds, commandId },
      status: 'READY',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Process all pending continuations (e.g. after server restart).
   * Uses handlers from init() unless overridden. Local mode only.
   */
  async recover(options?: { handlers?: CallbackHandlers; maxIterations?: number }): Promise<{ processed: number }> {
    if (this.config.mode !== 'local') {
      throw new Error('recover is only available in local mode');
    }
    const handlers = options?.handlers ?? this.initHandlers;
    const hasWork = handlers?.onWorkItem || handlers?.onServiceCall || handlers?.onDecision;
    const hasMi = !!handlers?.onMultiInstanceResolve;
    if (!hasWork && !hasMi) {
      throw new Error('recover requires init() handlers or options.handlers');
    }
    const { claimContinuation, processContinuation } = await import('../workers/processor');
    const { broadcastAll } = await import('../ws/broadcast');
    const maxIter = options?.maxIterations ?? 5000;
    const db = (this.config as { mode: 'local'; db: Db }).db;
    let processed = 0;
    for (let i = 0; i < maxIter; i++) {
      const cont = await claimContinuation(db);
      if (!cont) return { processed };
      const { outbox, events } = await processContinuation(db, cont);
      broadcastAll(outbox, events);
      processed++;
      for (const ob of outbox) {
        const item = { kind: ob.kind, instanceId: ob.instanceId, payload: ob.payload } as CallbackItem;
        if (ob.kind === 'CALLBACK_MULTI_INSTANCE_RESOLVE' && handlers.onMultiInstanceResolve) {
          const p = ob.payload as import('./types').CallbackMultiInstanceResolvePayload;
          const { items } = await handlers.onMultiInstanceResolve(item as {
            kind: 'CALLBACK_MULTI_INSTANCE_RESOLVE';
            instanceId: string;
            payload: import('./types').CallbackMultiInstanceResolvePayload;
          });
          await this.submitMultiInstanceData(ob.instanceId, {
            nodeId: p.nodeId,
            tokenId: p.tokenId,
            scopeId: p.scopeId,
            items,
          });
        } else if (ob.kind === 'CALLBACK_WORK') {
          const p = ob.payload as import('./types').CallbackWorkPayload;
          if (p.kind === 'userTask' && handlers.onWorkItem) {
            await handlers.onWorkItem(item as { kind: 'CALLBACK_WORK'; instanceId: string; payload: import('./types').CallbackWorkPayload });
          }
          if (p.kind === 'serviceTask' && handlers.onServiceCall) {
            await handlers.onServiceCall(item as { kind: 'CALLBACK_WORK'; instanceId: string; payload: import('./types').CallbackWorkPayload });
          }
        }
        if (ob.kind === 'CALLBACK_DECISION' && handlers.onDecision) {
          await handlers.onDecision(item as { kind: 'CALLBACK_DECISION'; instanceId: string; payload: import('./types').CallbackDecisionPayload });
        }
      }
    }
    return { processed };
  }

  /**
   * Run instance until terminal (COMPLETED/TERMINATED/FAILED) or quiescent.
   * Uses handlers from init() unless overridden. Local mode only.
   */
  async run(
    instanceId: string,
    handlers?: CallbackHandlers,
    options?: { maxIterations?: number }
  ): Promise<{ status: string }> {
    return this.processUntilComplete(instanceId, handlers, options);
  }

  /**
   * @deprecated Use run() for programmer's view. Same behavior.
   */
  async processUntilComplete(
    instanceId: string,
    handlers?: CallbackHandlers,
    options?: { maxIterations?: number }
  ): Promise<{ status: string }> {
    if (this.config.mode !== 'local') {
      throw new Error('processUntilComplete is only available in local mode');
    }
    const h = handlers ?? this.initHandlers;
    const hasWorkHandlers = h?.onWorkItem || h?.onServiceCall || h?.onDecision;
    const hasMiHandler = !!h?.onMultiInstanceResolve;
    if (!hasWorkHandlers && !hasMiHandler) {
      throw new Error('processUntilComplete requires init() handlers or handlers argument');
    }
    const { claimContinuation, processContinuation } = await import('../workers/processor');
    const { getInstance } = await import('../instance/service');
    const { broadcastAll } = await import('../ws/broadcast');
    const maxIter = options?.maxIterations ?? 500;

    const db = (this.config as { mode: 'local'; db: Db }).db;
    for (let i = 0; i < maxIter; i++) {
      const cont = await claimContinuation(db, { instanceId });
      if (!cont) {
        const instance = await getInstance(db, instanceId);
        return { status: instance?.status ?? 'UNKNOWN' };
      }

      const { outbox, events } = await processContinuation(db, cont);
      broadcastAll(outbox, events);

      for (const ev of events) {
        const payloadInstanceId = (ev.payload as { instanceId?: string }).instanceId;
        if (
          payloadInstanceId === instanceId &&
          (ev.type === 'INSTANCE_COMPLETED' ||
            ev.type === 'INSTANCE_TERMINATED' ||
            ev.type === 'INSTANCE_FAILED')
        ) {
          const instance = await getInstance(db, instanceId);
          return { status: instance?.status ?? ev.type };
        }
      }

      for (const ob of outbox) {
        if (ob.instanceId !== instanceId) continue;
        const item = {
          kind: ob.kind,
          instanceId: ob.instanceId,
          payload: ob.payload,
        } as CallbackItem;
        if (ob.kind === 'CALLBACK_MULTI_INSTANCE_RESOLVE' && h.onMultiInstanceResolve) {
          const p = ob.payload as import('./types').CallbackMultiInstanceResolvePayload;
          const { items } = await h.onMultiInstanceResolve(item as {
            kind: 'CALLBACK_MULTI_INSTANCE_RESOLVE';
            instanceId: string;
            payload: import('./types').CallbackMultiInstanceResolvePayload;
          });
          await this.submitMultiInstanceData(instanceId, {
            nodeId: p.nodeId,
            tokenId: p.tokenId,
            scopeId: p.scopeId,
            items,
          });
        } else if (ob.kind === 'CALLBACK_WORK') {
          const p = ob.payload as import('./types').CallbackWorkPayload;
          if (p.kind === 'userTask' && h.onWorkItem) {
            await h.onWorkItem(item as {
              kind: 'CALLBACK_WORK';
              instanceId: string;
              payload: import('./types').CallbackWorkPayload;
            });
          }
          if (p.kind === 'serviceTask' && h.onServiceCall) {
            await h.onServiceCall(item as {
              kind: 'CALLBACK_WORK';
              instanceId: string;
              payload: import('./types').CallbackWorkPayload;
            });
        }
        }
        if (ob.kind === 'CALLBACK_DECISION' && h.onDecision) {
          await h.onDecision(item as {
            kind: 'CALLBACK_DECISION';
            instanceId: string;
            payload: import('./types').CallbackDecisionPayload;
          });
        }
      }
    }

    const instance = await getInstance(db, instanceId);
    return { status: instance?.status ?? 'RUNNING' };
  }

  /**
   * Subscribe to callback events (work items, decisions).
   * REST: WebSocket at /ws. Local: internal engine loop (MongoDB passive).
   * Returns unsubscribe function.
   */
  subscribeToCallbacks(callback: (item: CallbackItem) => void): () => void {
    if (this.config.mode === 'local') {
      return this._subscribeLocal(callback);
    }
    return this._subscribeRest(callback);
  }

  private _subscribeLocal(callback: (item: CallbackItem) => void): () => void {
    if (this.config.mode !== 'local') throw new Error('Expected local config');
    const db = this.config.db;
    let stopped = false;
    const POLL_MS = 100;
    void (async () => {
      const { claimContinuation, processContinuation } = await import('../workers/processor');
      const { broadcastAll } = await import('../ws/broadcast');
      while (!stopped) {
        try {
          const cont = await claimContinuation(db);
          if (cont) {
            const { outbox, events } = await processContinuation(db, cont);
            broadcastAll(outbox, events);
            for (const ob of outbox) {
              if (!stopped) {
                callback({ kind: ob.kind, instanceId: ob.instanceId, payload: ob.payload } as CallbackItem);
              }
            }
          }
        } catch (_err) {
          // Ignore; loop continues
        }
        if (!stopped) await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
    return () => { stopped = true; };
  }

  private _subscribeRest(callback: (item: CallbackItem) => void): () => void {
    if (this.config.mode !== 'rest') throw new Error('Expected REST config');
    const wsUrl = this.config.baseUrl.replace(/^http/, 'ws') + '/ws';
    const WebSocket = require('ws') as new (url: string) => {
      on(event: string, handler: (data: unknown) => void): void;
      send(data: string): void;
      close(): void;
      readyState: number;
    };
    const ws = new WebSocket(wsUrl);
    ws.on('message', (data: unknown) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'callbacks' && Array.isArray(msg.items)) {
          for (const item of msg.items) {
            if (item.kind === 'CALLBACK_WORK' || item.kind === 'CALLBACK_DECISION' || item.kind === 'CALLBACK_MULTI_INSTANCE_RESOLVE') {
              callback(item as CallbackItem);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    });
    return () => ws.close();
  }

  // ── Timer schedules ───────────────────────────────────────────────────────

  async listTimerSchedules(params?: {
    definitionId?: string;
    status?: string;
  }): Promise<import('../db/collections').TimerScheduleDoc[]> {
    if (this.config.mode === 'rest') {
      const q = new URLSearchParams();
      if (params?.definitionId) q.set('definitionId', params.definitionId);
      if (params?.status) q.set('status', params.status);
      const res = await fetch(`${this.config.baseUrl}/v1/timer-schedules?${q}`);
      if (!res.ok) throw new Error(`List timer schedules failed: ${res.status}`);
      const json = (await res.json()) as { items: import('../db/collections').TimerScheduleDoc[] };
      return json.items;
    }
    const { getCollections } = await import('../db/collections');
    const { TimerSchedules } = getCollections(this.config.db);
    const filter: Record<string, unknown> = {};
    if (params?.definitionId) filter.definitionId = params.definitionId;
    if (params?.status) filter.status = params.status;
    return TimerSchedules.find(filter).sort({ nextFireAt: 1 }).toArray();
  }

  async pauseTimerSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/timer-schedules/${scheduleId}/pause`, { method: 'POST' });
      if (!res.ok) throw new Error(`Pause timer failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TimerSchedules } = getCollections(this.config.db);
    const result = await TimerSchedules.findOneAndUpdate(
      { _id: scheduleId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Timer schedule not found or not ACTIVE');
  }

  async resumeTimerSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/timer-schedules/${scheduleId}/resume`, { method: 'POST' });
      if (!res.ok) throw new Error(`Resume timer failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TimerSchedules } = getCollections(this.config.db);
    const result = await TimerSchedules.findOneAndUpdate(
      { _id: scheduleId, status: 'PAUSED' },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Timer schedule not found or not PAUSED');
  }

  // ── Connector schedules ─────────────────────────────────────────────────────

  async listConnectorSchedules(params?: {
    definitionId?: string;
    status?: string;
    connectorType?: string;
  }): Promise<import('../db/collections').ConnectorScheduleDoc[]> {
    if (this.config.mode === 'rest') {
      const q = new URLSearchParams();
      if (params?.definitionId) q.set('definitionId', params.definitionId);
      if (params?.status) q.set('status', params.status);
      if (params?.connectorType) q.set('connectorType', params.connectorType);
      const res = await fetch(`${this.config.baseUrl}/v1/connector-schedules?${q}`);
      if (!res.ok) throw new Error(`List connector schedules failed: ${res.status}`);
      const json = (await res.json()) as { items: import('../db/collections').ConnectorScheduleDoc[] };
      return json.items;
    }
    const { getCollections } = await import('../db/collections');
    const { ConnectorSchedules } = getCollections(this.config.db);
    const filter: Record<string, unknown> = {};
    if (params?.definitionId) filter.definitionId = params.definitionId;
    if (params?.status) filter.status = params.status;
    if (params?.connectorType) filter.connectorType = params.connectorType;
    return ConnectorSchedules.find(filter).sort({ createdAt: -1 }).toArray();
  }

  async pauseConnectorSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/connector-schedules/${scheduleId}/pause`, { method: 'POST' });
      if (!res.ok) throw new Error(`Pause connector failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { ConnectorSchedules } = getCollections(this.config.db);
    const result = await ConnectorSchedules.findOneAndUpdate(
      { _id: scheduleId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Connector schedule not found or not ACTIVE');
  }

  async resumeConnectorSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/connector-schedules/${scheduleId}/resume`, { method: 'POST' });
      if (!res.ok) throw new Error(`Resume connector failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { ConnectorSchedules } = getCollections(this.config.db);
    const result = await ConnectorSchedules.findOneAndUpdate(
      { _id: scheduleId, status: 'PAUSED' },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Connector schedule not found or not PAUSED');
  }

  /**
   * Set or update credentials on a connector schedule.
   * Stored in ConnectorSchedule.config — persisted in MongoDB, survives restarts.
   * The worker reads them at poll time, falling back to global config.graph.
   */
  async setConnectorCredentials(
    scheduleId: string,
    credentials: { tenantId: string; clientId: string; clientSecret: string },
  ): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/connector-schedules/${scheduleId}/credentials`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentials),
        },
      );
      if (!res.ok) throw new Error(`Set connector credentials failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { ConnectorSchedules } = getCollections(this.config.db);
    const result = await ConnectorSchedules.findOneAndUpdate(
      { _id: scheduleId },
      {
        $set: {
          'config.tenantId': credentials.tenantId,
          'config.clientId': credentials.clientId,
          'config.clientSecret': credentials.clientSecret,
          updatedAt: new Date(),
        },
      },
    );
    if (!result) throw new Error('Connector schedule not found');
  }

  /**
   * Close connections. No-op; caller manages DB/connection lifecycle.
   */
  async close(): Promise<void> {
    // Caller manages connection lifecycle
  }
}
