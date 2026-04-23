/**
 * TriggerFireEvent telemetry: one row per interesting fire (ok or error).
 * No-op cycles (empty observation, everything filtered) must NOT write —
 * the schedule's `lastFiredAt` heartbeat is the liveness indicator there.
 *
 * Exercises the reporter pipeline end-to-end with a synthetic trigger so we
 * don't depend on Graph or MCP.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import {
  getCollections,
  type TriggerScheduleDoc,
} from '../../src/db/collections';
import { TriggerRegistry } from '../../src/triggers/registry';
import type {
  BpmnClaim,
  BpmnStartEventView,
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../../src/triggers/types';
import { processOneTrigger } from '../../src/workers/trigger-scheduler';
import { deployDefinition } from '../../src/model/service';
import { BpmnEngineClient } from '../../src/sdk/client';

jest.setTimeout(15_000);

let db: Db;
let client: BpmnEngineClient;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
});

/** Minimal synthetic trigger — tests drive fire behavior via `nextBehavior`. */
type Behavior =
  | { kind: 'no-op' }
  | { kind: 'fire-one'; dedupKey?: string }
  | { kind: 'throw'; message: string }
  | { kind: 'callback-error'; reason: string; message: string }
  | { kind: 'inline-fire'; instanceIds: string[]; drops?: Record<string, number> };

let nextBehavior: Behavior = { kind: 'no-op' };

const fake: StartTrigger = {
  triggerType: 'fake-telemetry',
  defaultInitialPolicy: 'fire-existing',
  deployStatus: 'ACTIVE',
  claimFromBpmn: () => null,
  validate() { /* noop */ },
  nextSchedule(): TriggerSchedule {
    return { kind: 'fire-at', at: new Date(Date.now() + 60_000) };
  },
  async fire(inv: TriggerInvocation): Promise<TriggerResult> {
    const b = nextBehavior;
    switch (b.kind) {
      case 'no-op':
        inv.report?.observed(0);
        return { starts: [], nextCursor: null };
      case 'fire-one':
        inv.report?.observed(1);
        return {
          starts: [{ dedupKey: b.dedupKey ?? uuidv4(), payload: {} }],
          nextCursor: null,
        };
      case 'throw':
        throw new Error(b.message);
      case 'callback-error':
        // Simulate: inline plugin observed 1 item, startInstance'd it, then the
        // host callback threw — plugin reports error + treats as skip.
        inv.report?.observed(1);
        inv.report?.error(
          { stage: 'callback', message: b.message },
          { reason: b.reason },
        );
        return { starts: [], nextCursor: null };
      case 'inline-fire':
        inv.report?.observed(b.instanceIds.length + Object.values(b.drops ?? {}).reduce((a, v) => a + v, 0));
        for (const id of b.instanceIds) inv.report?.fired(id);
        for (const [k, v] of Object.entries(b.drops ?? {})) inv.report?.dropped(k, v);
        return { starts: [], nextCursor: null };
    }
  },
};

async function insertSchedule(
  overrides: Partial<TriggerScheduleDoc> = {},
): Promise<TriggerScheduleDoc> {
  const { definitionId } = await deployDefinition(db, {
    id: `fe-${uuidv4().slice(0, 8)}`,
    name: 'Fire Events Test',
    version: '1',
    bpmnXml: loadBpmn('start-service-task-end.bpmn'),
  });
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();
  const doc: TriggerScheduleDoc = {
    _id: uuidv4(),
    scheduleId: uuidv4(),
    definitionId,
    startEventId: 'Start_1',
    triggerType: 'fake-telemetry',
    config: {},
    cursor: null,
    credentials: null,
    initialPolicy: 'fire-existing',
    status: 'ACTIVE',
    nextFireAt: new Date(Date.now() - 1000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await TriggerSchedules.insertOne(doc);
  return doc;
}

async function fire(registry: TriggerRegistry): Promise<void> {
  await processOneTrigger(db, registry);
}

describe('TriggerFireEvent telemetry', () => {
  let registry: TriggerRegistry;
  beforeEach(() => {
    registry = new TriggerRegistry();
    registry.register(fake);
  });

  it('no-op fire writes no event (schedule heartbeat is the liveness marker)', async () => {
    const schedule = await insertSchedule();
    nextBehavior = { kind: 'no-op' };
    await fire(registry);

    const { TriggerFireEvents, TriggerSchedules } = getCollections(db);
    expect(await TriggerFireEvents.countDocuments({ scheduleId: schedule.scheduleId })).toBe(0);
    // Heartbeat is on the schedule, not in the events collection.
    const row = await TriggerSchedules.findOne({ _id: schedule._id });
    expect(row?.lastFiredAt).toBeInstanceOf(Date);
  });

  it('successful StartRequest fire writes outcome=ok with per-item counters', async () => {
    const schedule = await insertSchedule();
    nextBehavior = { kind: 'fire-one', dedupKey: 'k-1' };
    await fire(registry);

    const { TriggerFireEvents } = getCollections(db);
    const events = await TriggerFireEvents.find({ scheduleId: schedule.scheduleId }).toArray();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.outcome).toBe('ok');
    expect(ev.itemsObserved).toBe(1);
    expect(ev.itemsFired).toBe(1);
    expect(ev.itemsSkipped).toBe(0);
    expect(ev.instanceIds).toHaveLength(1);
    expect(ev.triggerType).toBe('fake-telemetry');
    expect(ev.definitionId).toBe(schedule.definitionId);
    expect(typeof ev.durationMs).toBe('number');
    expect(ev.error).toBeUndefined();
  });

  it('thrown fire writes outcome=error with error.stage=fire', async () => {
    const schedule = await insertSchedule();
    nextBehavior = { kind: 'throw', message: 'upstream explosion' };
    await fire(registry);

    const { TriggerFireEvents } = getCollections(db);
    const events = await TriggerFireEvents.find({ scheduleId: schedule.scheduleId }).toArray();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.outcome).toBe('error');
    expect(ev.error?.stage).toBe('fire');
    expect(ev.error?.message).toContain('upstream explosion');
    expect(ev.itemsFired).toBe(0);
  });

  it('callback-only error with no successful fires → outcome=error', async () => {
    const schedule = await insertSchedule();
    nextBehavior = {
      kind: 'callback-error',
      reason: 'callback-error',
      message: 'host boom',
    };
    await fire(registry);

    const { TriggerFireEvents } = getCollections(db);
    const events = await TriggerFireEvents.find({ scheduleId: schedule.scheduleId }).toArray();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.outcome).toBe('error');
    expect(ev.error?.stage).toBe('callback');
    expect(ev.error?.message).toBe('host boom');
    expect(ev.dropReasons['callback-error']).toBe(1);
    expect(ev.itemsFired).toBe(0);
  });

  it('mixed fire with some items fired and some dropped → outcome=ok + dropReasons populated', async () => {
    const schedule = await insertSchedule();
    nextBehavior = {
      kind: 'inline-fire',
      instanceIds: ['i-1', 'i-2'],
      drops: { 'filter-pattern': 2, 'already-processed': 1 },
    };
    await fire(registry);

    const { TriggerFireEvents } = getCollections(db);
    const events = await TriggerFireEvents.find({ scheduleId: schedule.scheduleId }).toArray();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.outcome).toBe('ok');
    expect(ev.itemsObserved).toBe(5);
    expect(ev.itemsFired).toBe(2);
    expect(ev.itemsSkipped).toBe(3);
    expect(ev.dropReasons).toEqual({ 'filter-pattern': 2, 'already-processed': 1 });
    expect(ev.instanceIds).toEqual(['i-1', 'i-2']);
    expect(ev.error).toBeUndefined();
  });

  it('client.listFireEvents returns events newest-first, filters by outcome', async () => {
    const schedule = await insertSchedule();
    nextBehavior = { kind: 'fire-one', dedupKey: 'first' };
    await fire(registry);
    const { TriggerSchedules } = getCollections(db);
    // Re-arm so the next claim picks it up (interval heuristic).
    await TriggerSchedules.updateOne(
      { _id: schedule._id },
      { $set: { nextFireAt: new Date(Date.now() - 1000), lastFiredAt: new Date(0) } },
    );
    nextBehavior = { kind: 'throw', message: 'boom2' };
    await fire(registry);

    // Re-register custom fake on the *default* registry so the client-invoked path
    // (via the SDK's local helpers) can't accidentally see two instances. Here
    // we're just reading — no trigger lookup needed.
    const all = await client.listFireEvents({ scheduleId: schedule.scheduleId });
    expect(all).toHaveLength(2);
    // Newest-first by firedAt.
    expect(all[0].firedAt.getTime()).toBeGreaterThanOrEqual(all[1].firedAt.getTime());

    const errorsOnly = await client.listFireEvents({
      scheduleId: schedule.scheduleId,
      outcome: 'error',
    });
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0].error?.message).toContain('boom2');
  });

  it('telemetry write failure does not break the fire path', async () => {
    const schedule = await insertSchedule();
    const { TriggerFireEvents } = getCollections(db);
    const origInsert = TriggerFireEvents.insertOne.bind(TriggerFireEvents);
    // Simulate a broken telemetry insert.
    (TriggerFireEvents as any).insertOne = async () => {
      throw new Error('mongo down');
    };
    try {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      nextBehavior = { kind: 'fire-one', dedupKey: 'resilient' };
      await fire(registry);
      errSpy.mockRestore();

      // Instance still created despite telemetry failure.
      const { ProcessInstances } = getCollections(db);
      const count = await ProcessInstances.countDocuments({ definitionId: schedule.definitionId });
      expect(count).toBe(1);
    } finally {
      (TriggerFireEvents as any).insertOne = origInsert;
    }
  });
});
