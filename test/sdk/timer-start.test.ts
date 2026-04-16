/**
 * SDK test: timer start events.
 * Verifies that deploying a BPMN with a timer start event creates a TimerSchedule,
 * and that the timer worker fires it to create a process instance.
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
import { processOneTimer } from '../../src/timers/worker';
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

describe('Timer start event', () => {
  it('deploy creates a TimerSchedule for timer start events', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'timer-start',
      name: 'Timer Start',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listTimerSchedules({ definitionId });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].kind).toBe('cycle');
    expect(schedules[0].expression).toBe('R/PT10S');
    expect(schedules[0].status).toBe('ACTIVE');
    expect(schedules[0].remainingReps).toBeNull(); // unbounded
    expect(new Date(schedules[0].nextFireAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('timer worker fires a due timer and creates an instance', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'timer-start',
      name: 'Timer Start',
      version: '1',
      bpmnXml,
    });

    // Force the timer to be due now
    const { TimerSchedules } = getCollections(db);
    await TimerSchedules.updateOne(
      { definitionId },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );

    // Fire the timer
    const fired = await processOneTimer(db);
    expect(fired).toBe(true);

    // Verify an instance was created
    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('RUNNING');

    // Verify the schedule was advanced (not exhausted, since it's unbounded)
    const schedule = (await client.listTimerSchedules({ definitionId }))[0];
    expect(schedule.status).toBe('ACTIVE');
    expect(schedule.lastFiredAt).toBeDefined();
    expect(new Date(schedule.nextFireAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('redeploy replaces the timer schedule', async () => {
    const bpmnXml = loadBpmn('timer-start.bpmn');

    await client.deploy({ id: 'timer-start', name: 'Timer Start', version: '1', bpmnXml });
    const before = await client.listTimerSchedules();
    expect(before).toHaveLength(1);

    // Redeploy with overwrite
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

    // Timer worker should not fire a paused timer
    const { TimerSchedules } = getCollections(db);
    await TimerSchedules.updateOne(
      { _id: scheduleId },
      { $set: { nextFireAt: new Date(Date.now() - 1000) } },
    );
    const fired = await processOneTimer(db);
    expect(fired).toBe(false);

    await client.resumeTimerSchedule(scheduleId);
    const resumed = (await client.listTimerSchedules({ definitionId }))[0];
    expect(resumed.status).toBe('ACTIVE');
  });

  it('bounded cycle exhausts after all repetitions', async () => {
    // Create a BPMN with R2/PT10S (2 repetitions) inline
    const bpmnXml = loadBpmn('timer-start.bpmn').replace('R/PT10S', 'R2/PT10S');
    const { definitionId } = await client.deploy({
      id: 'timer-bounded',
      name: 'Timer Bounded',
      version: '1',
      bpmnXml,
    });

    const { TimerSchedules } = getCollections(db);

    // Fire 1
    await TimerSchedules.updateOne({ definitionId }, { $set: { nextFireAt: new Date(Date.now() - 1000) } });
    expect(await processOneTimer(db)).toBe(true);

    let schedule = (await client.listTimerSchedules({ definitionId }))[0];
    expect(schedule.status).toBe('ACTIVE');
    expect(schedule.remainingReps).toBe(1);

    // Fire 2
    await TimerSchedules.updateOne({ definitionId }, { $set: { nextFireAt: new Date(Date.now() - 1000) } });
    expect(await processOneTimer(db)).toBe(true);

    schedule = (await client.listTimerSchedules({ definitionId }))[0];
    expect(schedule.status).toBe('EXHAUSTED');
    expect(schedule.remainingReps).toBe(0);

    // No more fires
    expect(await processOneTimer(db)).toBe(false);
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
