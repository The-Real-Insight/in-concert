/**
 * SDK integration test: generic trigger scheduler.
 *
 * Uses a fake StartTrigger so the test is hermetic (no network, no timers).
 * Verifies:
 *   - claimDueSchedule picks up due rows
 *   - fire() is invoked with the right invocation
 *   - starts land as ProcessInstances, deduped by idempotencyKey
 *   - cursor, lastFiredAt, and next-schedule timing persist atomically
 *   - transient fire() errors are recorded as lastError and the lease is released
 *   - unregistered triggerType is recorded as an error
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
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../../src/triggers/types';
import {
  claimDueSchedule,
  fireClaimedSchedule,
  processOneTrigger,
} from '../../src/workers/trigger-scheduler';
import { deployDefinition } from '../../src/model/service';

jest.setTimeout(15_000);

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

async function deploy(): Promise<string> {
  const { definitionId } = await deployDefinition(db, {
    id: `trig-${uuidv4().slice(0, 8)}`,
    name: 'Trigger Scheduler Test',
    version: '1',
    bpmnXml: loadBpmn('start-service-task-end.bpmn'),
  });
  return definitionId;
}

async function insertSchedule(
  overrides: Partial<TriggerScheduleDoc>,
): Promise<TriggerScheduleDoc> {
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();
  const doc: TriggerScheduleDoc = {
    _id: uuidv4(),
    scheduleId: uuidv4(),
    definitionId: overrides.definitionId ?? (await deploy()),
    startEventId: 'Start_1',
    triggerType: 'fake',
    config: {},
    cursor: null,
    credentials: null,
    initialPolicy: 'fire-existing',
    status: 'ACTIVE',
    nextFireAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await TriggerSchedules.insertOne(doc);
  return doc;
}

type FakeLog = TriggerInvocation[];
function makeFakeTrigger(
  behavior: (inv: TriggerInvocation) => TriggerResult | Promise<TriggerResult>,
  nextSchedule: TriggerSchedule = { kind: 'fire-at', at: new Date(Date.now() + 60_000) },
  triggerType = 'fake',
): { trigger: StartTrigger; log: FakeLog } {
  const log: FakeLog = [];
  const trigger: StartTrigger = {
    triggerType,
    defaultInitialPolicy: 'fire-existing',
    claimFromBpmn: () => null, // schedules inserted directly; BPMN-claim path not exercised
    validate() {
      /* noop */
    },
    nextSchedule(_def, _lastFiredAt, _cursor) {
      return nextSchedule;
    },
    async fire(inv) {
      log.push(inv);
      return behavior(inv);
    },
  };
  return { trigger, log };
}

describe('trigger-scheduler', () => {
  it('claims a due row and fires it; starts land as process instances', async () => {
    const schedule = await insertSchedule({ nextFireAt: new Date(Date.now() - 1000) });
    const { trigger, log } = makeFakeTrigger(() => ({
      starts: [{ dedupKey: 'item-1', payload: {} }],
      nextCursor: 'cursor-v2',
    }));
    const registry = new TriggerRegistry();
    registry.register(trigger);

    const worked = await processOneTrigger(db, registry);
    expect(worked).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0].scheduleId).toBe(schedule.scheduleId);

    const { ProcessInstances, TriggerSchedules } = getCollections(db);
    const insts = await ProcessInstances.find({ definitionId: schedule.definitionId }).toArray();
    expect(insts).toHaveLength(1);
    expect(insts[0].idempotencyKey).toBe(`${schedule.scheduleId}:item-1`);

    const rowAfter = await TriggerSchedules.findOne({ _id: schedule._id });
    expect(rowAfter?.cursor).toBe('cursor-v2');
    expect(rowAfter?.lastFiredAt).toBeInstanceOf(Date);
    expect(rowAfter?.lastError).toBeUndefined();
    expect(rowAfter?.leaseUntil).toBeUndefined();
    expect(rowAfter?.ownerId).toBeUndefined();
  });

  it('dedupes starts across two fires with the same dedupKey', async () => {
    const schedule = await insertSchedule({ nextFireAt: new Date(Date.now() - 1000) });
    const { trigger } = makeFakeTrigger(() => ({
      starts: [{ dedupKey: 'same-key', payload: {} }],
      nextCursor: null,
    }));
    const registry = new TriggerRegistry();
    registry.register(trigger);

    // First fire → new instance.
    await processOneTrigger(db, registry);

    // Force re-claim by reopening the schedule window.
    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne(
      { _id: schedule._id },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );

    // Second fire → the trigger emits the same dedupKey again → no new instance.
    await processOneTrigger(db, registry);

    const { ProcessInstances } = getCollections(db);
    const count = await ProcessInstances.countDocuments({
      definitionId: schedule.definitionId,
    });
    expect(count).toBe(1);
  });

  it('applies interval nextSchedule by setting intervalMs and clearing nextFireAt', async () => {
    const schedule = await insertSchedule({ nextFireAt: new Date(Date.now() - 1000) });
    const { trigger } = makeFakeTrigger(
      () => ({ starts: [], nextCursor: null }),
      { kind: 'interval', ms: 120_000 },
    );
    const registry = new TriggerRegistry();
    registry.register(trigger);

    await processOneTrigger(db, registry);

    const { TriggerSchedules } = getCollections(db);
    const rowAfter = await TriggerSchedules.findOne({ _id: schedule._id });
    expect(rowAfter?.intervalMs).toBe(120_000);
    expect(rowAfter?.nextFireAt).toBeUndefined();
  });

  it('records fire() error as lastError and releases the lease', async () => {
    const schedule = await insertSchedule({ nextFireAt: new Date(Date.now() - 1000) });
    const { trigger } = makeFakeTrigger(() => {
      throw new Error('boom');
    });
    const registry = new TriggerRegistry();
    registry.register(trigger);

    const claimed = await claimDueSchedule(db);
    expect(claimed).not.toBeNull();
    await fireClaimedSchedule(db, registry, claimed!);

    const { TriggerSchedules } = getCollections(db);
    const rowAfter = await TriggerSchedules.findOne({ _id: schedule._id });
    expect(rowAfter?.lastError).toBe('boom');
    expect(rowAfter?.leaseUntil).toBeUndefined();
    // Cursor and lastFiredAt remain unchanged — fire did not complete.
    expect(rowAfter?.cursor).toBe(schedule.cursor);
    expect(rowAfter?.lastFiredAt).toBeUndefined();
  });

  it('unregistered triggerType is recorded as lastError', async () => {
    const schedule = await insertSchedule({
      triggerType: 'nonexistent',
      nextFireAt: new Date(Date.now() - 1000),
    });
    const registry = new TriggerRegistry();

    const claimed = await claimDueSchedule(db);
    await fireClaimedSchedule(db, registry, claimed!);

    const { TriggerSchedules } = getCollections(db);
    const rowAfter = await TriggerSchedules.findOne({ _id: schedule._id });
    expect(rowAfter?.lastError).toMatch(/No trigger registered/);
  });

  it('claims interval rows when lastFiredAt + intervalMs is in the past', async () => {
    const schedule = await insertSchedule({
      nextFireAt: undefined,
      intervalMs: 1000,
      lastFiredAt: new Date(Date.now() - 60_000),
    });
    const { trigger, log } = makeFakeTrigger(() => ({
      starts: [],
      nextCursor: null,
    }));
    const registry = new TriggerRegistry();
    registry.register(trigger);

    const worked = await processOneTrigger(db, registry);
    expect(worked).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0].scheduleId).toBe(schedule.scheduleId);
  });

  it('does not claim PAUSED schedules', async () => {
    await insertSchedule({
      status: 'PAUSED',
      nextFireAt: new Date(Date.now() - 1000),
    });
    const registry = new TriggerRegistry();
    registry.register(makeFakeTrigger(() => ({ starts: [], nextCursor: null })).trigger);

    const worked = await processOneTrigger(db, registry);
    expect(worked).toBe(false);
  });
});
