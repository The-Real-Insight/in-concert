/**
 * SDK integration test: crash recovery.
 *
 * Verifies the two safety nets that let in-flight work survive a server crash:
 *   1. `sweepExpiredLeases` reclaims `Continuations` stuck in `IN_PROGRESS`
 *      with an expired `leaseUntil` back to `READY`.
 *   2. `dispatchOutboxBatch` re-broadcasts `Outbox` rows that stayed `READY`
 *      (e.g. because the server crashed between transaction commit and the
 *      inline broadcast) and marks them `SENT`.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections, type ContinuationDoc, type OutboxDoc } from '../../src/db/collections';
import { sweepExpiredLeases } from '../../src/workers/sweeper';
import {
  dispatchOutboxBatch,
  markOutboxSent,
} from '../../src/workers/outbox-dispatcher';
import { addStreamHandler } from '../../src/ws/broadcast';
import { BpmnEngineClient } from '../../src/sdk/client';
import { claimContinuation, processContinuation } from '../../src/workers/processor';

jest.setTimeout(20_000);

let db: Db;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
});

function makeContinuation(overrides: Partial<ContinuationDoc> = {}): ContinuationDoc {
  const now = new Date();
  return {
    _id: uuidv4(),
    instanceId: uuidv4(),
    dueAt: now,
    kind: 'START',
    payload: { commandId: uuidv4() },
    status: 'READY',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeOutbox(overrides: Partial<OutboxDoc> = {}): OutboxDoc {
  const now = new Date();
  const instanceId = uuidv4();
  return {
    _id: uuidv4(),
    instanceId,
    rootInstanceId: instanceId,
    kind: 'CALLBACK_WORK',
    destination: { url: 'http://localhost/callback' },
    payload: { workItemId: uuidv4(), kind: 'userTask' },
    status: 'READY',
    attempts: 0,
    nextAttemptAt: now,
    idempotencyKey: uuidv4(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('sweepExpiredLeases', () => {
  it('reclaims IN_PROGRESS continuations with expired lease back to READY', async () => {
    const { Continuations } = getCollections(db);
    const expired = makeContinuation({
      status: 'IN_PROGRESS',
      ownerId: 'worker-abc',
      leaseUntil: new Date(Date.now() - 60_000),
    });
    const live = makeContinuation({
      status: 'IN_PROGRESS',
      ownerId: 'worker-xyz',
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const ready = makeContinuation({ status: 'READY' });
    await Continuations.insertMany([expired, live, ready]);

    const result = await sweepExpiredLeases(db);
    expect(result.continuations).toBe(1);

    const reclaimed = await Continuations.findOne({ _id: expired._id });
    expect(reclaimed?.status).toBe('READY');
    expect(reclaimed?.ownerId).toBeUndefined();
    expect(reclaimed?.leaseUntil).toBeUndefined();

    const untouched = await Continuations.findOne({ _id: live._id });
    expect(untouched?.status).toBe('IN_PROGRESS');
    expect(untouched?.ownerId).toBe('worker-xyz');
  });

  it('is a no-op when no leases have expired', async () => {
    const { Continuations } = getCollections(db);
    await Continuations.insertOne(makeContinuation({ status: 'READY' }));
    const result = await sweepExpiredLeases(db);
    expect(result).toEqual({ continuations: 0, timers: 0, connectors: 0 });
  });
});

describe('dispatchOutboxBatch', () => {
  it('broadcasts stale READY rows and marks them SENT', async () => {
    const { Outbox } = getCollections(db);
    const old = new Date(Date.now() - 60_000);
    const stale = makeOutbox({ status: 'READY', createdAt: old, updatedAt: old });
    const fresh = makeOutbox({ status: 'READY' }); // just created, not yet stale
    await Outbox.insertMany([stale, fresh]);

    const received: Array<{ kind: string; instanceId: string }> = [];
    const unsubscribe = addStreamHandler((payload) => {
      for (const c of payload.callbacks ?? []) {
        received.push({ kind: c.kind, instanceId: c.instanceId });
      }
    });

    try {
      const dispatched = await dispatchOutboxBatch(db);
      expect(dispatched).toBe(1);
      expect(received).toEqual([{ kind: 'CALLBACK_WORK', instanceId: stale.instanceId }]);

      const staleAfter = await Outbox.findOne({ _id: stale._id });
      expect(staleAfter?.status).toBe('SENT');

      const freshAfter = await Outbox.findOne({ _id: fresh._id });
      expect(freshAfter?.status).toBe('READY');
    } finally {
      unsubscribe();
    }
  });

  it('does not re-send rows that were already marked SENT inline', async () => {
    const { Outbox } = getCollections(db);
    const old = new Date(Date.now() - 60_000);
    const alreadySent = makeOutbox({ status: 'SENT', createdAt: old, updatedAt: old });
    await Outbox.insertOne(alreadySent);

    const received: Array<{ kind: string }> = [];
    const unsubscribe = addStreamHandler((payload) => {
      for (const c of payload.callbacks ?? []) received.push({ kind: c.kind });
    });

    try {
      const dispatched = await dispatchOutboxBatch(db);
      expect(dispatched).toBe(0);
      expect(received).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('markOutboxSent only flips READY rows to SENT', async () => {
    const { Outbox } = getCollections(db);
    const readyRow = makeOutbox({ status: 'READY' });
    const deadRow = makeOutbox({ status: 'DEAD' });
    await Outbox.insertMany([readyRow, deadRow]);

    await markOutboxSent(db, [readyRow._id, deadRow._id]);

    const readyAfter = await Outbox.findOne({ _id: readyRow._id });
    expect(readyAfter?.status).toBe('SENT');

    const deadAfter = await Outbox.findOne({ _id: deadRow._id });
    expect(deadAfter?.status).toBe('DEAD');
  });
});

/**
 * End-to-end crash-simulation tests: drive a real instance, interrupt a real
 * processing step, then verify the recovery primitives actually drive the
 * instance to completion.
 *
 * These exercise the same code paths the server worker loop runs, so they
 * validate the "survives crash" claim beyond the isolated unit tests above.
 */
describe('end-to-end crash simulation', () => {
  it('claimed but unprocessed continuation is reclaimed + driven to COMPLETED by run()', async () => {
    // 1. Deploy a real BPMN: Start → serviceTask → End.
    const client = new BpmnEngineClient({ mode: 'local', db });
    const serviceCalls: string[] = [];
    client.init({
      onServiceCall: async (item) => {
        serviceCalls.push(item.payload.workItemId);
        await client.completeExternalTask(item.instanceId, item.payload.workItemId);
      },
    });
    const { definitionId } = await client.deploy({
      id: `crash-cont-${uuidv4().slice(0, 8)}`,
      name: 'Crash Cont',
      version: '1',
      bpmnXml: loadBpmn('start-service-task-end.bpmn'),
    });

    // 2. Start the instance — creates a READY START continuation.
    const { instanceId } = await client.startInstance({ commandId: uuidv4(), definitionId });

    const { Continuations, ProcessInstances } = getCollections(db);
    const startCont = await Continuations.findOne({ instanceId, status: 'READY' });
    expect(startCont).not.toBeNull();

    // 3. Crash simulation: claim the continuation and never call
    //    processContinuation. The worker died between claim and process.
    //    Note: findOneAndUpdate returns the pre-update doc by default, so we
    //    check the actual DB state instead of the return value.
    const claimed = await claimContinuation(db, { instanceId });
    expect(claimed?._id).toBe(startCont!._id);
    const claimedRow = await Continuations.findOne({ _id: claimed!._id });
    expect(claimedRow?.status).toBe('IN_PROGRESS');
    expect(claimedRow?.leaseUntil).toBeDefined();

    // 4. Force the lease into the past (emulating a lease that outlived the
    //    worker's process).
    await Continuations.updateOne(
      { _id: claimed!._id },
      { $set: { leaseUntil: new Date(Date.now() - 60_000) } },
    );

    // Confirm run() alone can't progress the instance — the continuation is
    // still IN_PROGRESS, so claimContinuation returns null.
    const runBefore = await client.run(instanceId, undefined, { maxIterations: 5 });
    expect(runBefore.status).toBe('RUNNING');
    const instanceMid = await ProcessInstances.findOne({ _id: instanceId });
    expect(instanceMid?.status).toBe('RUNNING');

    // 5. Sweep — this is the recovery primitive that should un-stick things.
    const swept = await sweepExpiredLeases(db);
    expect(swept.continuations).toBeGreaterThanOrEqual(1);

    const reclaimed = await Continuations.findOne({ _id: claimed!._id });
    expect(reclaimed?.status).toBe('READY');

    // 6. Now run() can drive the instance to completion.
    const runAfter = await client.run(instanceId);
    expect(runAfter.status).toBe('COMPLETED');
    expect(serviceCalls).toHaveLength(1);

    const instanceFinal = await ProcessInstances.findOne({ _id: instanceId });
    expect(instanceFinal?.status).toBe('COMPLETED');
  });

  it('persisted-but-undispatched outbox row is picked up by dispatcher and delivered', async () => {
    // 1. Deploy BPMN whose first step produces a CALLBACK_WORK outbox entry.
    const client = new BpmnEngineClient({ mode: 'local', db });
    client.init({
      onServiceCall: async () => {
        // Handler intentionally unused here — we don't call run(), we drive
        // processContinuation directly to simulate a crash at the exact
        // moment between transaction commit and inline broadcast.
      },
    });
    const { definitionId } = await client.deploy({
      id: `crash-outbox-${uuidv4().slice(0, 8)}`,
      name: 'Crash Outbox',
      version: '1',
      bpmnXml: loadBpmn('start-service-task-end.bpmn'),
    });
    const { instanceId } = await client.startInstance({ commandId: uuidv4(), definitionId });

    // 2. Drive continuations directly (mimicking the worker loop) until one
    //    produces the CALLBACK_WORK outbox row for the service task. Then
    //    stop — that's the crash: the row is committed to Mongo with
    //    status=READY, but broadcastAll + markOutboxSent are never invoked.
    let outboxRowId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const cont = await claimContinuation(db, { instanceId });
      if (!cont) break;
      const result = await processContinuation(db, cont);
      const hit = result.outbox.find((ob) => ob.kind === 'CALLBACK_WORK');
      if (hit) {
        outboxRowId = hit._id;
        break;
      }
    }
    expect(outboxRowId).toBeDefined();

    // 3. Confirm the outbox row is in Mongo with status=READY and nobody has
    //    been notified of the callback yet.
    const { Outbox } = getCollections(db);
    const row = await Outbox.findOne({ _id: outboxRowId });
    expect(row?.status).toBe('READY');

    const received: Array<{ kind: string; instanceId: string }> = [];
    const unsubscribe = addStreamHandler((payload) => {
      for (const c of payload.callbacks ?? []) {
        received.push({ kind: c.kind, instanceId: c.instanceId });
      }
    });

    try {
      // 4. Recovery: the dispatcher should find the stale row, broadcast it,
      //    and mark it SENT. stalenessMs=0 so we don't have to wait.
      const dispatched = await dispatchOutboxBatch(db, { stalenessMs: 0 });
      expect(dispatched).toBeGreaterThanOrEqual(1);

      expect(received).toContainEqual({ kind: 'CALLBACK_WORK', instanceId });

      const rowAfter = await Outbox.findOne({ _id: outboxRowId });
      expect(rowAfter?.status).toBe('SENT');
    } finally {
      unsubscribe();
    }
  });
});
