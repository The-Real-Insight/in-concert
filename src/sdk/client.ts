/**
 * tri-bpmn-engine SDK
 * Use mode: 'rest' to talk to a running server, or mode: 'local' to bypass REST.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import type {
  DeployParams,
  DeployResult,
  StartInstanceParams,
  StartInstanceResult,
  InstanceSummary,
  InstanceState,
  CallbackItem,
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

  constructor(config: SdkConfig) {
    this.config = config;
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
   * Complete a work item (user task or service task).
   */
  async completeWorkItem(
    instanceId: string,
    workItemId: string,
    options?: { commandId?: string; result?: Record<string, unknown> }
  ): Promise<void> {
    const commandId = options?.commandId ?? uuidv4();
    if (this.config.mode === 'rest') {
      const res = await fetch(
        `${this.config.baseUrl}/v1/instances/${instanceId}/work-items/${workItemId}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, result: options?.result }),
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
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId,
      dueAt: now,
      kind: 'WORK_COMPLETED',
      payload: { workItemId, commandId, ...(options?.result && { result: options.result }) },
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
   * Run the worker (process continuations). Local mode only.
   * In REST mode, the server runs its own worker loop.
   * When outbox entries are produced (work items, decisions), onCallbacks is invoked.
   * Callbacks stream from the engine—MongoDB is purely passive persistence.
   */
  async runWorker(
    maxIterations = 50,
    onCallbacks?: (items: CallbackItem[]) => void
  ): Promise<number> {
    if (this.config.mode === 'rest') {
      throw new Error('runWorker is only available in local mode');
    }
    const { claimContinuation, processContinuation } = await import('../workers/processor');
    let count = 0;
    for (let i = 0; i < maxIterations; i++) {
      const cont = await claimContinuation(this.config.db);
      if (!cont) break;
      const outbox = await processContinuation(this.config.db, cont);
      count++;
      if (outbox.length > 0 && onCallbacks) {
        const items: CallbackItem[] = outbox.map((ob) => ({
          kind: ob.kind,
          instanceId: ob.instanceId,
          payload: ob.payload,
        })) as CallbackItem[];
        onCallbacks(items);
      }
    }
    return count;
  }

  /**
   * Subscribe to callback events (work items, decisions).
   * REST: WebSocket at /ws. Local: engine-driven via runWorker loop (MongoDB passive).
   * Returns unsubscribe function.
   */
  subscribeToCallbacks(callback: (item: CallbackItem) => void): () => void {
    if (this.config.mode === 'local') {
      return this._subscribeLocal(callback);
    }
    return this._subscribeRest(callback);
  }

  private _subscribeLocal(callback: (item: CallbackItem) => void): () => void {
    let stopped = false;
    const POLL_MS = 100;
    void (async () => {
      while (!stopped) {
        try {
          await this.runWorker(20, (items) => {
            for (const item of items) {
              if (!stopped) callback(item);
            }
          });
        } catch (_err) {
          // Ignore; loop continues
        }
        if (!stopped) {
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      }
    })();
    return () => {
      stopped = true;
    };
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
            if (item.kind === 'CALLBACK_WORK' || item.kind === 'CALLBACK_DECISION') {
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

  /**
   * Close connections. No-op; caller manages DB/connection lifecycle.
   */
  async close(): Promise<void> {
    // Caller manages connection lifecycle
  }
}
