/**
 * SDK test: timer start events.
 * Verifies that deploying a BPMN with a timer start event creates a
 * TriggerSchedule row (triggerType='timer'), and that the generic trigger
 * scheduler fires it to create a process instance.
 */
import type { Db } from 'mongodb';
import { BpmnEngineClient } from '../../src/sdk/client';
import {
  setupDb,
  teardownDb,
  loadBpmn,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { processOneTrigger } from '../../src/workers/trigger-scheduler';
import { getDefaultTriggerRegistry } from '../../src/triggers';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;
let unsubscribeProjection: (() => void) | null = null;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  unsubscribeProjection = addStreamHandler(createProjectionHandler(db));

  client.init({
    onServiceCall: async (item) => {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });
});

afterAll(async () => {
  unsubscribeProjection?.();
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
});

/** Pull the remainingReps out of the opaque timer cursor for assertions. */
function remainingRepsFromCursor(cursor: string | null | undefined): number | null | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as { remainingReps?: number | null };
    return parsed.remainingReps;
  } catch {
    return undefined;
  }
}

async function fireOneTrigger(): Promise<boolean> {
  return processOneTrigger(db, getDefaultTriggerRegistry());
}

describe('Timer start event', () => {
  it('deploy creates a TriggerSchedule for timer start events', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'timer-start',
      name: 'Timer Start',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listTimerSchedules({ definitionId });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].triggerType).toBe('timer');
    expect(schedules[0].config.expression).toBe('R/PT10S');
    expect(schedules[0].status).toBe('ACTIVE');
    // Initial cursor is null (remainingReps is seeded on first fire from the
    // cycle expression — for unbounded R/PT10S, that's null forever).
    expect(schedules[0].cursor).toBeNull();
    expect(schedules[0].nextFireAt).toBeDefined();
    expect(new Date(schedules[0].nextFireAt as Date).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it('trigger scheduler fires a due timer and creates an instance', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'timer-start',
      name: 'Timer Start',
      version: '1',
      bpmnXml,
    });

    // Force the timer to be due now.
    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne(
      { definitionId, triggerType: 'timer' },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );

    const fired = await fireOneTrigger();
    expect(fired).toBe(true);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('RUNNING');

    const schedule = (await client.listTimerSchedules({ definitionId }))[0];
    expect(schedule.status).toBe('ACTIVE');
    expect(schedule.lastFiredAt).toBeDefined();
    expect(new Date(schedule.nextFireAt as Date).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });

  it('redeploy replaces the timer schedule', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');

    await client.deploy({ id: 'timer-start', name: 'Timer Start', version: '1', bpmnXml });
    const before = await client.listTimerSchedules();
    expect(before).toHaveLength(1);

    await client.deploy({ id: 'timer-start', name: 'Timer Start', version: '1', bpmnXml, overwrite: true });
    const after = await client.listTimerSchedules();
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('ACTIVE');
  });

  it('pause and resume a timer schedule', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'timer-start',
      name: 'Timer Start',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listTimerSchedules({ definitionId });
    const scheduleId = schedules[0]._id;

    await client.pauseTimerSchedule(scheduleId);
    const paused = (await client.listTimerSchedules({ definitionId }))[0];
    expect(paused.status).toBe('PAUSED');

    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne(
      { _id: scheduleId },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );
    expect(await fireOneTrigger()).toBe(false);

    await client.resumeTimerSchedule(scheduleId);
    const resumed = (await client.listTimerSchedules({ definitionId }))[0];
    expect(resumed.status).toBe('ACTIVE');
  });

  it('bounded cycle exhausts after all repetitions', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn').replace('R/PT10S', 'R2/PT10S');
    const { definitionId } = await client.deploy({
      id: 'timer-bounded',
      name: 'Timer Bounded',
      version: '1',
      bpmnXml,
    });

    const { TriggerSchedules } = getCollections(db);

    // Fire 1
    await TriggerSchedules.updateOne(
      { definitionId, triggerType: 'timer' },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );
    expect(await fireOneTrigger()).toBe(true);

    let schedule = (await client.listTimerSchedules({ definitionId }))[0];
    expect(schedule.status).toBe('ACTIVE');
    expect(remainingRepsFromCursor(schedule.cursor)).toBe(1);

    // Fire 2
    await TriggerSchedules.updateOne(
      { definitionId, triggerType: 'timer' },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );
    expect(await fireOneTrigger()).toBe(true);

    schedule = (await client.listTimerSchedules({ definitionId }))[0];
    expect(schedule.status).toBe('EXHAUSTED');
    expect(remainingRepsFromCursor(schedule.cursor)).toBe(0);

    // No more fires.
    expect(await fireOneTrigger()).toBe(false);
  });

  it('deploying a process without timer start creates no schedule', async () => {
    const bpmnXml = loadBpmn('start-service-task-end.bpmn');
    const { definitionId } = await client.deploy({
      id: 'no-timer',
      name: 'No Timer',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listTimerSchedules({ definitionId });
    expect(schedules).toHaveLength(0);
  });
});
