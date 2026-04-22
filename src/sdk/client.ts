/**
 * tri-bpmn-engine SDK
 * Use mode: 'rest' to talk to a running server, or mode: 'local' to bypass REST.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { emitEngineAttributionNoticeOnce } from '../attribution';
import type {
  ActivateSchedulesOptions,
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

    // Forward the onMailReceived hook to the registered graph-mailbox trigger.
    if (config.onMailReceived) {
      const { getDefaultTriggerRegistry } = require('../triggers') as typeof import('../triggers');
      const { GraphMailboxTrigger } = require('../triggers/graph-mailbox/graph-mailbox-trigger') as typeof import('../triggers/graph-mailbox/graph-mailbox-trigger');
      const mailbox = getDefaultTriggerRegistry().get('graph-mailbox');
      if (mailbox instanceof GraphMailboxTrigger) {
        mailbox.setOnMailReceived(config.onMailReceived);
      }
    }

    // Deprecated: engine-level graph-mailbox credentials. Prefer per-schedule
    // credentials via client.setConnectorCredentials(). Forwarded to env so
    // the plugin picks them up via its own credential resolution.
    const gc = config.connectors?.['graph-mailbox'];
    if (gc) {
      if (gc.tenantId) process.env.GRAPH_TENANT_ID = gc.tenantId;
      if (gc.clientId) process.env.GRAPH_CLIENT_ID = gc.clientId;
      if (gc.clientSecret) process.env.GRAPH_CLIENT_SECRET = gc.clientSecret;
    }
  }

  /**
   * Extract timer and connector events from a BPMN model without deploying.
   * Pure function — no DB, no server. Use to inspect what a model needs before deploy.
   */
  async extractEvents(params: { bpmnXml: string }): Promise<Array<{
    type: 'timer' | 'connector';
    nodeId: string;
    expression?: string;
    connectorType?: string;
    config?: Record<string, string>;
  }>> {
    const { parseBpmnXml } = await import('../model/parser');
    const graph = await parseBpmnXml(params.bpmnXml);
    const events: Array<{
      type: 'timer' | 'connector';
      nodeId: string;
      expression?: string;
      connectorType?: string;
      config?: Record<string, string>;
    }> = [];

    for (const startId of graph.startNodeIds) {
      const node = graph.nodes[startId];
      if (!node || node.type !== 'startEvent') continue;
      if (node.timerDefinition) {
        events.push({ type: 'timer', nodeId: node.id, expression: node.timerDefinition });
      }
      if (node.connectorConfig?.connectorType) {
        const { connectorType, ...rest } = node.connectorConfig;
        events.push({ type: 'connector', nodeId: node.id, connectorType, config: rest });
      }
    }
    return events;
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
   * Purge an instance and the full transitive closure of its descendant
   * instances (children from call activities, grandchildren, etc.) together
   * with all dependent rows: ProcessInstance, ProcessInstanceState,
   * ProcessInstanceEvent, ProcessInstanceHistory, Continuation, Outbox, and
   * HumanTask. Returns null if the instance does not exist.
   */
  async purgeInstance(
    instanceId: string
  ): Promise<{ purgedInstanceIds: string[] } | null> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/instances/${instanceId}`, {
        method: 'DELETE',
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `Purge failed: ${res.status}`);
      }
      return (await res.json()) as { purgedInstanceIds: string[] };
    }
    const { purgeInstance } = await import('../instance/service');
    return purgeInstance(this.config.db, instanceId);
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
   * Restore in-flight work after a server restart. Call once at startup,
   * after {@link init}, before the first {@link run}.
   *
   * Performs three steps in order:
   *   1. Reclaims continuations that a previous process started but never
   *      finished (e.g. crashed mid-step), so they become claimable again.
   *   2. Re-delivers any callback (`onWorkItem`, `onServiceCall`,
   *      `onDecision`, `onMultiInstanceResolve`) that was persisted but
   *      never handed to a handler because the process died between
   *      commit and callback delivery.
   *   3. Drains every pending continuation, invoking the init handlers,
   *      until the queue is empty.
   *
   * Standard startup pattern:
   *
   *     const engine = getBpmEngineClient();
   *     engine.init({ onServiceCall, onWorkItem, onDecision });
   *     await engine.recover();   // survive crashes from prior runs
   *     // ...then run() for user-initiated or scheduled starts
   *
   * Handlers are required — without them, re-delivered callbacks would be
   * silently dropped. `recover()` throws if no handlers are set via
   * `init()` or `options.handlers`. Local mode only.
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
    const { sweepExpiredLeases } = await import('../workers/sweeper');
    const { markOutboxSent, dispatchOutboxBatch } = await import('../workers/outbox-dispatcher');
    const maxIter = options?.maxIterations ?? 5000;
    const db = (this.config as { mode: 'local'; db: Db }).db;
    await sweepExpiredLeases(db);
    await dispatchOutboxBatch(db, { stalenessMs: 0 });
    let processed = 0;
    for (let i = 0; i < maxIter; i++) {
      const cont = await claimContinuation(db);
      if (!cont) return { processed };
      const { outbox, events } = await processContinuation(db, cont);
      broadcastAll(outbox, events);
      if (outbox.length > 0) {
        await markOutboxSent(db, outbox.map((o) => o._id));
      }
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
    const { markOutboxSent } = await import('../workers/outbox-dispatcher');
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
      if (outbox.length > 0) {
        await markOutboxSent(db, outbox.map((o) => o._id));
      }

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
  subscribeToCallbacks(
    callback: (item: CallbackItem) => void,
    options?: { getExcludedInstanceIds?: () => string[] }
  ): () => void {
    if (this.config.mode === 'local') {
      return this._subscribeLocal(callback, options);
    }
    return this._subscribeRest(callback);
  }

  private _subscribeLocal(
    callback: (item: CallbackItem) => void,
    options?: { getExcludedInstanceIds?: () => string[] }
  ): () => void {
    if (this.config.mode !== 'local') throw new Error('Expected local config');
    const db = this.config.db;
    let stopped = false;
    const POLL_MS = 100;
    void (async () => {
      const { claimContinuation, processContinuation } = await import('../workers/processor');
      const { broadcastAll } = await import('../ws/broadcast');
      const { markOutboxSent } = await import('../workers/outbox-dispatcher');
      while (!stopped) {
        try {
          const excludeInstanceIds = options?.getExcludedInstanceIds?.() ?? [];
          const cont = await claimContinuation(db, { excludeInstanceIds });
          if (cont) {
            const { outbox, events } = await processContinuation(db, cont);
            broadcastAll(outbox, events);
            if (outbox.length > 0) {
              await markOutboxSent(db, outbox.map((o) => o._id));
            }
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

  // ── Trigger schedules (canonical) ─────────────────────────────────────────

  async listTriggerSchedules(params?: {
    definitionId?: string;
    status?: string;
    triggerType?: string;
  }): Promise<import('../db/collections').TriggerScheduleDoc[]> {
    if (this.config.mode === 'rest') {
      const q = new URLSearchParams();
      if (params?.definitionId) q.set('definitionId', params.definitionId);
      if (params?.status) q.set('status', params.status);
      if (params?.triggerType) q.set('triggerType', params.triggerType);
      const res = await fetch(`${this.config.baseUrl}/v1/trigger-schedules?${q}`);
      if (!res.ok) throw new Error(`List trigger schedules failed: ${res.status}`);
      const json = (await res.json()) as {
        items: import('../db/collections').TriggerScheduleDoc[];
      };
      return json.items;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const filter: Record<string, unknown> = {};
    if (params?.definitionId) filter.definitionId = params.definitionId;
    if (params?.status) filter.status = params.status;
    if (params?.triggerType) filter.triggerType = params.triggerType;
    return TriggerSchedules.find(filter).sort({ createdAt: -1 }).toArray();
  }

  async pauseTriggerSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/trigger-schedules/${scheduleId}/pause`, { method: 'POST' });
      if (!res.ok) throw new Error(`Pause trigger failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Trigger schedule not found or not ACTIVE');
  }

  async resumeTriggerSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/trigger-schedules/${scheduleId}/resume`, { method: 'POST' });
      if (!res.ok) throw new Error(`Resume trigger failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId, status: 'PAUSED' },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Trigger schedule not found or not PAUSED');
  }

  /** Set arbitrary credentials on a trigger schedule. Schema is trigger-defined. */
  async setTriggerCredentials(
    scheduleId: string,
    credentials: Record<string, unknown>,
  ): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/trigger-schedules/${scheduleId}/credentials`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentials),
        },
      );
      if (!res.ok) throw new Error(`Set trigger credentials failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId },
      { $set: { credentials, updatedAt: new Date() } },
    );
    if (!result) throw new Error('Trigger schedule not found');
  }

  // ── Timer schedules (legacy alias) ─────────────────────────────────────────

  async listTimerSchedules(params?: {
    definitionId?: string;
    status?: string;
  }): Promise<import('../db/collections').TriggerScheduleDoc[]> {
    if (this.config.mode === 'rest') {
      const q = new URLSearchParams();
      if (params?.definitionId) q.set('definitionId', params.definitionId);
      if (params?.status) q.set('status', params.status);
      const res = await fetch(`${this.config.baseUrl}/v1/timer-schedules?${q}`);
      if (!res.ok) throw new Error(`List timer schedules failed: ${res.status}`);
      const json = (await res.json()) as {
        items: import('../db/collections').TriggerScheduleDoc[];
      };
      return json.items;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const filter: Record<string, unknown> = { triggerType: 'timer' };
    if (params?.definitionId) filter.definitionId = params.definitionId;
    if (params?.status) filter.status = params.status;
    return TriggerSchedules.find(filter).sort({ nextFireAt: 1 }).toArray();
  }

  async pauseTimerSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/timer-schedules/${scheduleId}/pause`, { method: 'POST' });
      if (!res.ok) throw new Error(`Pause timer failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId, triggerType: 'timer', status: 'ACTIVE' },
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
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId, triggerType: 'timer', status: 'PAUSED' },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Timer schedule not found or not PAUSED');
  }

  // ── Connector schedules ─────────────────────────────────────────────────────

  async listConnectorSchedules(params?: {
    definitionId?: string;
    status?: string;
    connectorType?: string;
  }): Promise<import('../db/collections').TriggerScheduleDoc[]> {
    if (this.config.mode === 'rest') {
      const q = new URLSearchParams();
      if (params?.definitionId) q.set('definitionId', params.definitionId);
      if (params?.status) q.set('status', params.status);
      if (params?.connectorType) q.set('connectorType', params.connectorType);
      const res = await fetch(`${this.config.baseUrl}/v1/connector-schedules?${q}`);
      if (!res.ok) throw new Error(`List connector schedules failed: ${res.status}`);
      const json = (await res.json()) as {
        items: import('../db/collections').TriggerScheduleDoc[];
      };
      return json.items;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const filter: Record<string, unknown> = { triggerType: { $ne: 'timer' } };
    if (params?.definitionId) filter.definitionId = params.definitionId;
    if (params?.status) filter.status = params.status;
    if (params?.connectorType) filter.triggerType = params.connectorType;
    return TriggerSchedules.find(filter).sort({ createdAt: -1 }).toArray();
  }

  async pauseConnectorSchedule(scheduleId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(`${this.config.baseUrl}/v1/connector-schedules/${scheduleId}/pause`, { method: 'POST' });
      if (!res.ok) throw new Error(`Pause connector failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId, triggerType: { $ne: 'timer' }, status: 'ACTIVE' },
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
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId, triggerType: { $ne: 'timer' }, status: 'PAUSED' },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } },
    );
    if (!result) throw new Error('Connector schedule not found or not PAUSED');
  }

  /**
   * Set or update credentials on a trigger schedule. Stored in
   * TriggerSchedule.credentials — persisted in MongoDB, survives restarts.
   * Only applies to non-timer triggers (mailbox, sharepoint-folder, etc.)
   * where credentials are relevant.
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
    const { TriggerSchedules } = getCollections(this.config.db);
    const result = await TriggerSchedules.findOneAndUpdate(
      { _id: scheduleId },
      {
        $set: {
          // Credentials are stored on the dedicated field now, but also
          // mirrored into config.* for backward-compatibility with test
          // assertions that read credentials.clientId off config.*.
          credentials,
          'config.tenantId': credentials.tenantId,
          'config.clientId': credentials.clientId,
          'config.clientSecret': credentials.clientSecret,
          updatedAt: new Date(),
        },
      },
    );
    if (!result) throw new Error('Connector schedule not found');
  }

  // ── Bulk schedule management ────────────────────────────────────────────────

  /**
   * Activate all schedules (timers + connectors) for a definition.
   * Sets Graph credentials on all connector schedules and resumes everything.
   * One call to go from PAUSED (after deploy) to ACTIVE (polling/firing).
   */
  async activateSchedules(
    definitionId: string,
    options?: ActivateSchedulesOptions,
  ): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/definitions/${definitionId}/schedules/activate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options ?? {}),
        },
      );
      if (!res.ok) throw new Error(`Activate schedules failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const now = new Date();

    // Non-timer triggers (mailbox, sharepoint, …): activate + optional credentials.
    const connectorSet: Record<string, unknown> = { status: 'ACTIVE', updatedAt: now };
    if (options?.graphCredentials) {
      const gc = options.graphCredentials;
      connectorSet.credentials = gc;
      connectorSet['config.tenantId'] = gc.tenantId;
      connectorSet['config.clientId'] = gc.clientId;
      connectorSet['config.clientSecret'] = gc.clientSecret;
    }
    if (options?.startingTenantId) {
      connectorSet.startingTenantId = options.startingTenantId;
    }
    await TriggerSchedules.updateMany(
      { definitionId, triggerType: { $ne: 'timer' } },
      { $set: connectorSet },
    );

    // Timer triggers: activate (unless EXHAUSTED).
    const timerSet: Record<string, unknown> = { status: 'ACTIVE', updatedAt: now };
    if (options?.startingTenantId) {
      timerSet.startingTenantId = options.startingTenantId;
    }
    await TriggerSchedules.updateMany(
      { definitionId, triggerType: 'timer', status: { $ne: 'EXHAUSTED' } },
      { $set: timerSet },
    );
  }

  /**
   * Deactivate all schedules (timers + connectors) for a definition.
   * Pauses everything — no more polling or firing until activateSchedules is called.
   */
  async deactivateSchedules(definitionId: string): Promise<void> {
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/definitions/${definitionId}/schedules/deactivate`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`Deactivate schedules failed: ${res.status}`);
      return;
    }
    const { getCollections } = await import('../db/collections');
    const { TriggerSchedules } = getCollections(this.config.db);
    const now = new Date();
    await TriggerSchedules.updateMany(
      { definitionId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED', updatedAt: now } },
    );
  }

  /**
   * Start the trigger scheduler polling loop (local mode only).
   *
   * Drains due `TriggerSchedule` rows against the given registry, one schedule
   * per iteration. Without this loop, ACTIVE schedules sit in Mongo and never
   * fire — the SDK owns the loop so embedding hosts don't have to reach into
   * `dist/workers/trigger-scheduler` across the package's exports boundary.
   *
   * Returns a stop function; call it on shutdown to let the current iteration
   * finish and exit the loop.
   *
   * REST mode: no-op with a warning — the in-concert server runs its own
   * `triggerLoop` in-process. Still returns a stop function for call-site
   * symmetry.
   */
  startTriggerScheduler(options?: {
    registry?: import('../triggers/registry').TriggerRegistry;
    pollMs?: number;
    onError?: (err: unknown) => void;
  }): () => void {
    if (this.config.mode !== 'local') {
      console.warn(
        '[in-concert] startTriggerScheduler() is a no-op in REST mode — the server runs its own trigger loop.',
      );
      return () => {
        /* noop */
      };
    }
    const db = this.config.db;
    const pollMs = options?.pollMs ?? 1_000;
    const onError = options?.onError;
    let stopped = false;
    void (async () => {
      const { processOneTrigger } = await import('../workers/trigger-scheduler');
      const { getDefaultTriggerRegistry } = await import('../triggers');
      const registry = options?.registry ?? getDefaultTriggerRegistry();
      while (!stopped) {
        try {
          const fired = await processOneTrigger(db, registry);
          if (fired) continue; // drain immediately when a schedule fired
        } catch (err) {
          if (onError) onError(err);
          // else: swallow — next iteration will try again
        }
        if (!stopped) await new Promise((r) => setTimeout(r, pollMs));
      }
    })();
    return () => {
      stopped = true;
    };
  }

  /**
   * Close connections. No-op; caller manages DB/connection lifecycle.
   */
  async close(): Promise<void> {
    // Caller manages connection lifecycle
  }
}
