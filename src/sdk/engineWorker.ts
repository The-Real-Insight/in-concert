/**
 * EngineWorker: singleton continuation dispatcher.
 *
 * Replaces the two pre-existing loops (per-call `processUntilComplete` owned
 * by `run()`, and the background `_subscribeLocal` poller owned by
 * `subscribeToCallbacks`). A single in-process worker claims every
 * continuation, dispatches to callback handlers, and publishes lifecycle
 * events that `run()` awaits. No exclusion list, no race.
 *
 * Concurrency model:
 *   - One poller finds distinct instanceIds that have READY continuations and
 *     are not already being drained.
 *   - For each candidate, ownership decides whether this server should take
 *     it (`InstanceOwnership.shouldProcess`). In single-server mode this is
 *     always yes; in multi-server mode it checks a DB-backed lease.
 *   - Each accepted candidate gets an instance-worker. Within one instance,
 *     continuations are processed strictly in FIFO order (serial). Across
 *     instances, workers run in parallel up to `poolCap`.
 *   - Instance-workers exit when the instance has no more claimable work;
 *     they notify any `run()` waiters with the instance's current status
 *     (quiescent `RUNNING`, or terminal `COMPLETED`/`TERMINATED`/`FAILED`).
 *
 * The main seam for future multi-server scaleout is `InstanceOwnership`;
 * nothing else in this module needs to change to add DB-backed leases.
 */
import type { Db } from 'mongodb';
import type { CallbackHandlers, CallbackItem } from './types';
import type { InstanceOwnership } from './ownership';
import { SingleServerOwnership } from './ownership';

export type EngineWorkerOptions = {
  /** Poll interval (ms) when looking for new instances with work. Default 100. */
  pollMs?: number;
  /** Max concurrent instance-workers. Default 16. */
  poolCap?: number;
  /**
   * Per-server ownership policy. Defaults to `SingleServerOwnership` (accept
   * every candidate). Swap in a DB-backed implementation when scaling out.
   */
  ownership?: InstanceOwnership;
};

type QuiescenceResult = { status: string };

type Waiter = {
  resolve: (result: QuiescenceResult) => void;
  reject: (err: unknown) => void;
};

export class EngineWorker {
  private db: Db;
  private handlers: CallbackHandlers;
  private pollMs: number;
  private poolCap: number;
  private ownership: InstanceOwnership;

  private stopped = true;
  /** Instances currently being drained (one promise per in-flight instance). */
  private inFlight: Map<string, Promise<void>> = new Map();
  /** run() callers awaiting quiescence for an instance. */
  private waiters: Map<string, Waiter[]> = new Map();
  /** Wakes the poll loop out of its sleep so `run()` gets immediate attention. */
  private wake: (() => void) | null = null;

  constructor(db: Db, handlers: CallbackHandlers, options?: EngineWorkerOptions) {
    this.db = db;
    this.handlers = handlers;
    this.pollMs = options?.pollMs ?? 100;
    this.poolCap = options?.poolCap ?? 16;
    this.ownership = options?.ownership ?? new SingleServerOwnership();
  }

  /** Start the poll loop. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.pollLoop();
  }

  /** Stop the poll loop. In-flight instance-workers drain to completion. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    // Wait for in-flight workers to finish.
    const inFlight = Array.from(this.inFlight.values());
    await Promise.allSettled(inFlight);
  }

  /**
   * Resolve when `instanceId` has no more claimable continuations (either the
   * process reached a waiting point or hit a terminal state). Result carries
   * the instance's current status.
   *
   * Also ensures an instance-worker is spawned for `instanceId`, so a caller
   * who just wrote a START continuation doesn't have to wait for the next
   * poll tick — and a caller whose instance is already terminal gets notified
   * on the next microtask.
   */
  awaitQuiescent(instanceId: string): Promise<QuiescenceResult> {
    const p = new Promise<QuiescenceResult>((resolve, reject) => {
      const list = this.waiters.get(instanceId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(instanceId, list);
    });
    // Force this instance to be considered on the very next tick instead of
    // waiting up to `pollMs` for the loop to wake on its own. Safe to call
    // even if a worker already exists — `ensureInstanceWorker` is a no-op in
    // that case.
    void this.ensureInstanceWorker(instanceId);
    return p;
  }

  /**
   * Spawn an instance-worker for `instanceId` if one is not already running.
   * Honors `InstanceOwnership`: returns early if ownership declines.
   */
  private async ensureInstanceWorker(instanceId: string): Promise<void> {
    if (this.inFlight.has(instanceId)) return;
    if (this.inFlight.size >= this.poolCap) {
      // Pool full. The poll loop will pick up this instance as soon as a slot
      // frees; the waiter stays registered.
      return;
    }
    const decision = await this.ownership.shouldProcess(instanceId);
    if (decision !== 'process') return;
    await this.ownership.onClaim(instanceId);

    const promise = this.runInstanceWorker(instanceId).finally(async () => {
      this.inFlight.delete(instanceId);
      try {
        await this.ownership.onRelease(instanceId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[in-concert] ownership.onRelease failed:', err);
      }
    });
    this.inFlight.set(instanceId, promise);
  }

  /**
   * Per-instance drain. Claims + processes continuations one at a time for
   * `instanceId`, dispatching handlers for each `CALLBACK_WORK` /
   * `CALLBACK_DECISION` / `CALLBACK_MULTI_INSTANCE_RESOLVE` along the way.
   * Exits when a terminal instance event fires OR no more claimable work
   * exists. Resolves all pending `run()` waiters with the final status.
   */
  private async runInstanceWorker(instanceId: string): Promise<void> {
    const { claimContinuation, processContinuation } = await import('../workers/processor');
    const { getInstance } = await import('../instance/service');
    const { broadcastAll } = await import('../ws/broadcast');
    const { markOutboxSent } = await import('../workers/outbox-dispatcher');

    try {
      while (!this.stopped) {
        const cont = await claimContinuation(this.db, { instanceId });
        if (!cont) {
          // No more work for this instance; we're quiescent or terminal.
          const instance = await getInstance(this.db, instanceId);
          this.notifyWaiters(instanceId, { status: instance?.status ?? 'UNKNOWN' });
          return;
        }

        const { outbox, events } = await processContinuation(this.db, cont);
        broadcastAll(outbox, events);
        if (outbox.length > 0) {
          await markOutboxSent(this.db, outbox.map((o) => o._id));
        }

        // Check for terminal lifecycle event so we can notify waiters
        // promptly with the terminal status rather than round-tripping
        // through the next claim cycle.
        let terminalStatus: string | null = null;
        for (const ev of events) {
          const payloadInstanceId = (ev.payload as { instanceId?: string }).instanceId;
          if (
            payloadInstanceId === instanceId &&
            (ev.type === 'INSTANCE_COMPLETED' ||
              ev.type === 'INSTANCE_TERMINATED' ||
              ev.type === 'INSTANCE_FAILED')
          ) {
            const instance = await getInstance(this.db, instanceId);
            terminalStatus = instance?.status ?? ev.type;
            break;
          }
        }

        // Dispatch outbox callbacks in the order they were emitted.
        for (const ob of outbox) {
          if (ob.instanceId !== instanceId) continue;
          await this.dispatchOutboxItem(ob, instanceId);
        }

        if (terminalStatus !== null) {
          this.notifyWaiters(instanceId, { status: terminalStatus });
          return;
        }
      }
    } catch (err) {
      // Instance-worker failure: reject all waiters for this instance. The
      // next poll tick can re-spawn if there's still work; for now, the
      // caller sees the error.
      this.rejectWaiters(instanceId, err);
    }
  }

  private async dispatchOutboxItem(
    ob: { kind: string; instanceId: string; payload: unknown },
    instanceId: string
  ): Promise<void> {
    const item = {
      kind: ob.kind,
      instanceId: ob.instanceId,
      payload: ob.payload,
    } as CallbackItem;

    if (ob.kind === 'CALLBACK_MULTI_INSTANCE_RESOLVE' && this.handlers.onMultiInstanceResolve) {
      const p = ob.payload as import('./types').CallbackMultiInstanceResolvePayload;
      const { items } = await this.handlers.onMultiInstanceResolve(
        item as {
          kind: 'CALLBACK_MULTI_INSTANCE_RESOLVE';
          instanceId: string;
          payload: import('./types').CallbackMultiInstanceResolvePayload;
        }
      );
      // Write the MULTI_INSTANCE_RESOLVED continuation directly — we can't
      // call BpmnEngineClient.submitMultiInstanceData from here without a
      // circular reference, and the payload is simple enough to inline.
      const { v4: uuidv4 } = await import('uuid');
      const { getCollections } = await import('../db/collections');
      const { Continuations } = getCollections(this.db);
      const now = new Date();
      await Continuations.insertOne({
        _id: uuidv4(),
        instanceId,
        dueAt: now,
        kind: 'MULTI_INSTANCE_RESOLVED',
        payload: { nodeId: p.nodeId, tokenId: p.tokenId, scopeId: p.scopeId, items },
        status: 'READY',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else if (ob.kind === 'CALLBACK_WORK') {
      const p = ob.payload as import('./types').CallbackWorkPayload;
      if (p.kind === 'userTask' && this.handlers.onWorkItem) {
        await this.handlers.onWorkItem(
          item as {
            kind: 'CALLBACK_WORK';
            instanceId: string;
            payload: import('./types').CallbackWorkPayload;
          }
        );
      }
      if (p.kind === 'serviceTask' && this.handlers.onServiceCall) {
        await this.handlers.onServiceCall(
          item as {
            kind: 'CALLBACK_WORK';
            instanceId: string;
            payload: import('./types').CallbackWorkPayload;
          }
        );
      }
    } else if (ob.kind === 'CALLBACK_DECISION' && this.handlers.onDecision) {
      await this.handlers.onDecision(
        item as {
          kind: 'CALLBACK_DECISION';
          instanceId: string;
          payload: import('./types').CallbackDecisionPayload;
        }
      );
    }
  }

  /**
   * Main poll loop. Finds instances with READY continuations that aren't
   * currently being drained, and spawns an instance-worker per candidate up
   * to the pool cap. Sleeps `pollMs` between ticks (interruptible via
   * `wake()` so `awaitQuiescent` gets immediate attention).
   */
  private async pollLoop(): Promise<void> {
    const { getCollections } = await import('../db/collections');
    const { Continuations } = getCollections(this.db);

    while (!this.stopped) {
      try {
        if (this.inFlight.size < this.poolCap) {
          const now = new Date();
          const excluded = Array.from(this.inFlight.keys());
          const filter: Record<string, unknown> = {
            status: 'READY',
            dueAt: { $lte: now },
          };
          if (excluded.length > 0) {
            filter.instanceId = { $nin: excluded };
          }
          const candidates = (await Continuations.aggregate([
            { $match: filter },
            { $group: { _id: '$instanceId' } },
          ]).toArray()) as Array<{ _id: string }>;

          for (const { _id: instanceId } of candidates) {
            if (this.inFlight.size >= this.poolCap) break;
            // ensureInstanceWorker is re-entrant-safe; it checks inFlight
            // and pool cap itself.
            await this.ensureInstanceWorker(instanceId);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[in-concert] engine worker poll failed:', err);
      }

      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = null;
          resolve();
        }, this.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = null;
          resolve();
        };
      });
    }
  }

  private notifyWaiters(instanceId: string, result: QuiescenceResult): void {
    const list = this.waiters.get(instanceId);
    if (!list || list.length === 0) return;
    this.waiters.delete(instanceId);
    for (const w of list) {
      try {
        w.resolve(result);
      } catch {
        /* ignore */
      }
    }
  }

  private rejectWaiters(instanceId: string, err: unknown): void {
    const list = this.waiters.get(instanceId);
    if (!list || list.length === 0) return;
    this.waiters.delete(instanceId);
    for (const w of list) {
      try {
        w.reject(err);
      } catch {
        /* ignore */
      }
    }
  }
}
