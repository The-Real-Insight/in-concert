/**
 * Unified SDK facade: engine + worklist (tasks).
 *
 * const sdk = new TriSdk({
 *   engine: { mode: 'rest', baseUrl: 'http://localhost:3000' },
 *   tasks:  { baseUrl: 'http://localhost:3000' }  // same in monolith
 * });
 *
 * sdk.engine.deploy(...)  sdk.engine.startInstance(...)
 * sdk.tasks.list(...)     sdk.tasks.claim(...)    sdk.tasks.complete(...)
 */
import { BpmnEngineClient } from './client';
import type { HumanTaskDoc } from '../db/collections';

export type TriSdkEngineConfig =
  | { mode: 'rest'; baseUrl: string }
  | { mode: 'local'; db: import('mongodb').Db };

export type TriSdkConfig = {
  engine: TriSdkEngineConfig;
  tasks: { baseUrl: string };
};

export type TaskListParams = {
  assigneeUserId?: string;
  candidateRole?: string;
  status?: string;
  instanceId?: string;
  limit?: number;
  cursor?: string;
};

export type TaskListResult = {
  items: HumanTaskDoc[];
  nextCursor?: string;
};

export class TriSdk {
  readonly engine: BpmnEngineClient;
  readonly tasks: {
    list: (params?: TaskListParams) => Promise<TaskListResult>;
    get: (taskId: string) => Promise<HumanTaskDoc | null>;
    claim: (taskId: string, params: { commandId?: string; userId: string }) => Promise<HumanTaskDoc>;
    activate: (taskId: string, params: { commandId?: string; userId: string }) => Promise<HumanTaskDoc>;
    unclaim: (taskId: string, params: { commandId?: string; userId: string }) => Promise<HumanTaskDoc>;
    complete: (taskId: string, params: { commandId?: string; userId: string; result?: unknown }) => Promise<void>;
  };

  constructor(config: TriSdkConfig) {
    this.engine = new BpmnEngineClient(config.engine);
    const base = config.tasks.baseUrl.replace(/\/$/, '');

    this.tasks = {
      list: async (params?: TaskListParams) => {
        const q = new URLSearchParams();
        if (params?.assigneeUserId) q.set('assigneeUserId', params.assigneeUserId);
        if (params?.candidateRole) q.set('candidateRole', params.candidateRole);
        if (params?.status) q.set('status', params.status);
        if (params?.instanceId) q.set('instanceId', params.instanceId);
        if (params?.limit) q.set('limit', String(params.limit));
        if (params?.cursor) q.set('cursor', params.cursor);
        const res = await fetch(`${base}/v1/tasks?${q}`);
        if (!res.ok) throw new Error(`Tasks list failed: ${res.status}`);
        return res.json() as Promise<TaskListResult>;
      },

      get: async (taskId: string) => {
        const res = await fetch(`${base}/v1/tasks/${taskId}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Task get failed: ${res.status}`);
        return res.json() as Promise<HumanTaskDoc>;
      },

      claim: async (taskId: string, params: { commandId?: string; userId: string }) => {
        const { v4: uuidv4 } = await import('uuid');
        const commandId = params.commandId ?? uuidv4();
        const res = await fetch(`${base}/v1/tasks/${taskId}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, userId: params.userId }),
        });
        if (res.status === 409) throw new Error('Task already claimed or not OPEN');
        if (res.status === 404) throw new Error('Task not found');
        if (!res.ok) throw new Error(`Claim failed: ${res.status}`);
        return res.json() as Promise<HumanTaskDoc>;
      },

      activate: async (taskId: string, params: { commandId?: string; userId: string }) => {
        const { v4: uuidv4 } = await import('uuid');
        const commandId = params.commandId ?? uuidv4();
        const res = await fetch(`${base}/v1/tasks/${taskId}/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, userId: params.userId }),
        });
        if (res.status === 409) throw new Error('Task already activated by another user or not OPEN');
        if (res.status === 404) throw new Error('Task not found');
        if (!res.ok) throw new Error(`Activate failed: ${res.status}`);
        return res.json() as Promise<HumanTaskDoc>;
      },

      unclaim: async (taskId: string, params: { commandId?: string; userId: string }) => {
        const { v4: uuidv4 } = await import('uuid');
        const commandId = params.commandId ?? uuidv4();
        const res = await fetch(`${base}/v1/tasks/${taskId}/unclaim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, userId: params.userId }),
        });
        if (res.status === 409) throw new Error('Task not claimed by user');
        if (res.status === 404) throw new Error('Task not found');
        if (!res.ok) throw new Error(`Unclaim failed: ${res.status}`);
        return res.json() as Promise<HumanTaskDoc>;
      },

      complete: async (taskId: string, params: { commandId?: string; userId: string; result?: unknown }) => {
        const { v4: uuidv4 } = await import('uuid');
        const commandId = params.commandId ?? uuidv4();
        const res = await fetch(`${base}/v1/tasks/${taskId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commandId,
            userId: params.userId,
            result: params.result,
          }),
        });
        if (res.status === 409) throw new Error('Task already completed or canceled');
        if (res.status === 403) throw new Error('Task claimed by another user');
        if (res.status === 404) throw new Error('Task not found');
        if (!res.ok) throw new Error(`Complete failed: ${res.status}`);
      },
    };
  }
}
