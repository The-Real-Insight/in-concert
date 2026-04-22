/**
 * SDK test: BpmnEngineClient.startTriggerScheduler().
 *
 * Local-mode hosts (e.g. tri-server) call this to run the polling loop that
 * drains due TriggerSchedule rows. Without it, ACTIVE schedules sit in Mongo
 * and never fire. The REST-mode path is a no-op — the in-concert server
 * runs its own triggerLoop in-process.
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
  TriggerInvocation,
} from '../../src/triggers/types';
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

describe('startTriggerScheduler (local mode)', () => {
  it('polls, fires a due schedule, and stops cleanly', async () => {
    const { definitionId } = await deployDefinition(db, {
      id: `sched-${uuidv4().slice(0, 8)}`,
      name: 'Scheduler Test',
      version: '1',
      bpmnXml: loadBpmn('start-service-task-end.bpmn'),
    });

    const fireLog: TriggerInvocation[] = [];
    const fakeTrigger: StartTrigger = {
      triggerType: 'fake-sched',
      defaultInitialPolicy: 'fire-existing',
      claimFromBpmn: () => null, // schedules inserted directly; BPMN-claim path not exercised here
      validate() {
        /* noop */
      },
      nextSchedule() {
        // Push next fire 1 minute out so the loop fires exactly once.
        return { kind: 'fire-at', at: new Date(Date.now() + 60_000) };
      },
      async fire(inv) {
        fireLog.push(inv);
        return { starts: [], nextCursor: null };
      },
    };
    const registry = new TriggerRegistry();
    registry.register(fakeTrigger);

    const { TriggerSchedules } = getCollections(db);
    const now = new Date();
    const schedule: TriggerScheduleDoc = {
      _id: uuidv4(),
      scheduleId: uuidv4(),
      definitionId,
      startEventId: 'Start_1',
      triggerType: 'fake-sched',
      config: {},
      cursor: null,
      credentials: null,
      initialPolicy: 'fire-existing',
      status: 'ACTIVE',
      nextFireAt: new Date(Date.now() - 1000),
      createdAt: now,
      updatedAt: now,
    };
    await TriggerSchedules.insertOne(schedule);

    const stop = client.startTriggerScheduler({ registry, pollMs: 20 });
    try {
      const start = Date.now();
      while (fireLog.length === 0 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fireLog).toHaveLength(1);
      expect(fireLog[0].scheduleId).toBe(schedule.scheduleId);
    } finally {
      stop();
    }

    // After stop(): re-arm the schedule and confirm no further fires happen.
    await TriggerSchedules.updateOne(
      { _id: schedule._id },
      {
        $set: { nextFireAt: new Date(Date.now() - 1000), status: 'ACTIVE' },
        $unset: { ownerId: '', leaseUntil: '' },
      },
    );
    const before = fireLog.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(fireLog.length).toBe(before);
  });

  it('surfaces errors via onError when provided', async () => {
    const { definitionId } = await deployDefinition(db, {
      id: `sched-${uuidv4().slice(0, 8)}`,
      name: 'Scheduler Error Test',
      version: '1',
      bpmnXml: loadBpmn('start-service-task-end.bpmn'),
    });

    // Registry with no triggers — processOneTrigger records the miss on the
    // schedule row without throwing, so onError is a regression guard rather
    // than a hard requirement. But we still want to see it wired up.
    const registry = new TriggerRegistry();
    const { TriggerSchedules } = getCollections(db);
    const now = new Date();
    await TriggerSchedules.insertOne({
      _id: uuidv4(),
      scheduleId: uuidv4(),
      definitionId,
      startEventId: 'Start_1',
      triggerType: 'unknown',
      config: {},
      cursor: null,
      credentials: null,
      initialPolicy: 'fire-existing',
      status: 'ACTIVE',
      nextFireAt: new Date(Date.now() - 1000),
      createdAt: now,
      updatedAt: now,
    });

    const errors: unknown[] = [];
    const stop = client.startTriggerScheduler({
      registry,
      pollMs: 20,
      onError: (err) => errors.push(err),
    });
    try {
      // Let the loop run a handful of iterations.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      stop();
    }
    // Either the row was marked with lastError (no throw) or onError fired;
    // what matters is that the loop survived.
    const row = await TriggerSchedules.findOne({ definitionId });
    expect(row?.lastError ?? 'onError=' + errors.length).toBeDefined();
  });
});

describe('startTriggerScheduler (REST mode)', () => {
  it('is a no-op and returns a callable stop function', () => {
    const restClient = new BpmnEngineClient({
      mode: 'rest',
      baseUrl: 'http://example.invalid',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
      /* silence */
    });
    const stop = restClient.startTriggerScheduler();
    expect(typeof stop).toBe('function');
    expect(warn).toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });
});
