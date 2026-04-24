/**
 * EngineWorker: singleton continuation dispatcher, change-stream-driven.
 *
 * Replaces the old poll-and-claim loops with a MongoDB change stream on the
 * `Continuations` collection. When a continuation is inserted (or an
 * expired-lease sweep transitions one back to READY), the stream emits an
 * event — we pick up the `instanceId` from `fullDocument` and spawn an
 * instance-worker to drain that instance. Change stream events are read from
 * the oplog, which means by the time we receive one the write is durable and
 * visible to any subsequent `claimContinuation`. No read-after-write race,
 * no retry loops, no tuned timeouts.
 *
 * Concurrency model:
 *   - One change stream subscribes to `Continuations` inserts/updates where
 *     `fullDocument.status == 'READY'`. Each event surfaces a candidate
 *     `instanceId`.
 *   - For each candidate, `InstanceOwnership.shouldProcess` decides whether
 *     this server accepts it. Single-server mode accepts everything; the
 *     multi-server DB-lease implementation swaps in here without touching
 *     the rest of this module.
 *   - Each accepted candidate gets an instance-worker. Within one instance,
 *     continuations are processed in strict FIFO order. Across instances,
 *     workers run in parallel up to `poolCap`.
 *   - Instance-workers exit when the instance has no more claimable work;
 *     they notify any `run()` waiters with the instance's current status
 *     (quiescent `RUNNING`, or terminal `COMPLETED`/`TERMINATED`/`FAILED`).
 *
 * Fallback poll: a slow safety-net poll (default 5 s) covers two cases the
 * change stream alone can't: (1) delayed continuations with `dueAt` in the
 * future — change stream fired at insert time but the work isn't yet ripe —
 * and (2) resume-token gaps after a long reconnect (if the oplog rotated
 * past our resume position, we'd miss events). The poll rescans for
 * READY + due continuations and re-triggers `ensureInstanceWorker`.
 *
 * Requirements: MongoDB 3.6+ replica set (standalone mongod does not support
 * change streams). Atlas, any self-hosted replica set, or a single-node
 * `mongod --replSet rs0` all work.
 */
import type { ChangeStream, Db } from 'mongodb';
import type { CallbackHandlers, CallbackItem } from './types';
import type { InstanceOwnership } from './ownership';
import { SingleServerOwnership } from './ownership';

export type EngineWorkerOptions = {
  /** Fallback poll interval (ms) for delayed work and change-stream gaps. Default 5000. */
  fallbackPollMs?: number;
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
  private fallbackPollMs: number;
  private poolCap: number;
  private ownership: InstanceOwnership;

  private stopped = true;
  /** Instances currently being drained (one promise per in-flight instance). */
  private inFlight: Map<string, Promise<void>> = new Map();
  /** run() callers awaiting quiescence for an instance. */
  private waiters: Map<string, Waiter[]> = new Map();
  /** Current change stream handle; closed on stop(). */
  private changeStream: ChangeStream | null = null;

  constructor(db: Db, handlers: CallbackHandlers, options?: EngineWorkerOptions) {
    this.db = db;
    this.handlers = handlers;
    this.fallbackPollMs = options?.fallbackPollMs ?? 5_000;
    this.poolCap = options?.poolCap ?? 16;
    this.ownership = options?.ownership ?? new SingleServerOwnership();
  }

  /** Start the change stream + fallback poll. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.runChangeStream();
    void this.runFallbackPoll();
  }

  /**
   * Stop the change stream and fallback poll. In-flight instance-workers
   * drain to completion.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.changeStream) {
      try {
        await this.changeStream.close();
      } catch {
        /* best effort */
      }
      this.changeStream = null;
    }
    const inFlight = Array.from(this.inFlight.values());
    await Promise.allSettled(inFlight);
  }

  /**
   * Resolve when `instanceId` has no more claimable continuations (either the
   * process reached a waiting point or hit a terminal state). Result carries
   * the instance's current status.
   *
   * Also ensures an instance-worker is spawned for `instanceId` immediately,
   * so callers who just wrote a continuation don't have to wait for the
   * change stream to loop around — and callers whose instance is already
   * quiescent get notified on the next microtask.
   */
  awaitQuiescent(instanceId: string): Promise<QuiescenceResult> {
    const p = new Promise<QuiescenceResult>((resolve, reject) => {
      const list = this.waiters.get(instanceId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(instanceId, list);
    });
    void this.ensureInstanceWorker(instanceId);
    return p;
  }

  /**
   * Spawn an instance-worker for `instanceId` if one is not already running.
   * Honors `InstanceOwnership`: returns early if ownership declines.
   *
   * Reservation is SYNCHRONOUS: we set `inFlight` before any `await`, so two
   * parallel callers (e.g. the change stream firing on the START insert and
   * `awaitQuiescent` from `client.run()`) cannot both pass the guard and
   * spawn duplicate workers for the same instance. If duplicates did spawn,
   * they would race on `claimContinuation`; the loser would get null on a
   * fresh instance, call `notifyWaiters`, and resolve `run()` before the
   * winner dispatched any task. The caller would then see an empty worklist,
   * detach, and clear run context before the first callback fires.
   */
  private ensureInstanceWorker(instanceId: string): void {
    if (this.inFlight.has(instanceId)) return;
    if (this.inFlight.size >= this.poolCap) {
      // Pool full. The fallback poll (or the next change event) will retry;
      // the waiter stays registered.
      return;
    }
    const promise = this.runWithOwnership(instanceId).finally(() => {
      this.inFlight.delete(instanceId);
    });
    this.inFlight.set(instanceId, promise);
  }

  /**
   * Run ownership acquisition + instance-worker + release. Wrapped so that
   * `ensureInstanceWorker` can set `inFlight` synchronously before the first
   * await (inside `shouldProcess`).
   */
  private async runWithOwnership(instanceId: string): Promise<void> {
    const decision = await this.ownership.shouldProcess(instanceId);
    if (decision !== 'process') return;
    await this.ownership.onClaim(instanceId);
    try {
      await this.runInstanceWorker(instanceId);
    } finally {
      try {
        await this.ownership.onRelease(instanceId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[in-concert] ownership.onRelease failed:', err);
      }
    }
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
      // Instance-worker failure: reject all waiters for this instance.
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
   * Subscribe to the `Continuations` change stream. We pick up every insert
   * (newly-written continuation) and every update that sets `status` back
   * to `READY` (the lease-sweeper recovering a stalled IN_PROGRESS row).
   * For each event, we derive the `instanceId` from `fullDocument` and ask
   * `ensureInstanceWorker` to take it.
   *
   * Auto-reconnect: the driver's ChangeStream retries transient errors
   * internally. On fatal errors we catch, sleep briefly, and re-open the
   * stream — the fallback poll covers any events we might have missed
   * during the downtime.
   */
  private async runChangeStream(): Promise<void> {
    const { getCollections } = await import('../db/collections');
    const { Continuations } = getCollections(this.db);

    const pipeline = [
      {
        $match: {
          $or: [
            { operationType: 'insert', 'fullDocument.status': 'READY' },
            // Sweeper-revived leases: update that sets status back to READY.
            {
              operationType: 'update',
              'fullDocument.status': 'READY',
              'updateDescription.updatedFields.status': 'READY',
            },
          ],
        },
      },
    ];

    while (!this.stopped) {
      let stream: ChangeStream | null = null;
      try {
        stream = Continuations.watch(pipeline, {
          fullDocument: 'updateLookup',
        });
        this.changeStream = stream;
        for await (const change of stream) {
          if (this.stopped) break;
          const doc = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
          if (!doc) continue;
          const instanceId = doc.instanceId as string | undefined;
          if (!instanceId) continue;
          const dueAt = doc.dueAt as Date | undefined;
          if (dueAt && dueAt.getTime() > Date.now()) {
            // Delayed continuation — let the fallback poll pick it up when
            // it's due. Don't hold an instance-worker slot waiting.
            continue;
          }
          void this.ensureInstanceWorker(instanceId);
        }
      } catch (err) {
        if (this.stopped) break;
        // eslint-disable-next-line no-console
        console.error('[in-concert] change stream error; reopening:', err);
        await new Promise((r) => setTimeout(r, 1_000));
      } finally {
        if (stream) {
          try {
            await stream.close();
          } catch {
            /* best effort */
          }
        }
        this.changeStream = null;
      }
    }
  }

  /**
   * Slow safety-net poll. Finds instances with READY + due continuations
   * that aren't already in-flight and spawns instance-workers for them.
   * Covers two cases the change stream doesn't: (1) delayed continuations
   * with `dueAt` in the future (event fired at insert, but claim must wait
   * until the due time), and (2) any event the stream missed during a
   * reconnect past a resume-token gap.
   */
  private async runFallbackPoll(): Promise<void> {
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
            await this.ensureInstanceWorker(instanceId);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[in-concert] fallback poll failed:', err);
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, this.fallbackPollMs));
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
