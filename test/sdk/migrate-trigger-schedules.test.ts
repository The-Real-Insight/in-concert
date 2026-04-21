/**
 * SDK integration test: migration from TimerSchedule + ConnectorSchedule
 * into the unified TriggerSchedule collection.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { setupDb, teardownDb } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import {
  getCollections,
  type TimerScheduleDoc,
  type ConnectorScheduleDoc,
} from '../../src/db/collections';
import { migrateToTriggerSchedules } from '../../scripts/migrate-to-trigger-schedules';

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

function makeTimer(overrides: Partial<TimerScheduleDoc> = {}): TimerScheduleDoc {
  const now = new Date();
  return {
    _id: uuidv4(),
    definitionId: uuidv4(),
    nodeId: 'TimerStart_1',
    kind: 'cycle',
    expression: 'R/PT10S',
    nextFireAt: now,
    remainingReps: null,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeConnector(
  overrides: Partial<ConnectorScheduleDoc> = {},
): ConnectorScheduleDoc {
  const now = new Date();
  return {
    _id: uuidv4(),
    definitionId: uuidv4(),
    nodeId: 'MailStart_1',
    connectorType: 'graph-mailbox',
    config: { mailbox: 'ops@example.com' },
    pollingIntervalMs: 60_000,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('migrateToTriggerSchedules', () => {
  it('copies timers into TriggerSchedules with triggerType=timer', async () => {
    const { TimerSchedules, TriggerSchedules } = getCollections(db);
    const t = makeTimer({ kind: 'rrule', expression: 'RRULE:FREQ=DAILY' });
    await TimerSchedules.insertOne(t);

    const stats = await migrateToTriggerSchedules(db);
    expect(stats.timersFound).toBe(1);
    expect(stats.timersMigrated).toBe(1);

    const migrated = await TriggerSchedules.findOne({ scheduleId: t._id });
    expect(migrated).not.toBeNull();
    expect(migrated?.triggerType).toBe('timer');
    expect(migrated?.startEventId).toBe(t.nodeId);
    expect(migrated?.config).toEqual({ kind: 'rrule', expression: 'RRULE:FREQ=DAILY' });
    expect(migrated?.status).toBe('ACTIVE');
    expect(migrated?.nextFireAt).toEqual(t.nextFireAt);
  });

  it('copies connectors into TriggerSchedules with the connector-type as triggerType', async () => {
    const { ConnectorSchedules, TriggerSchedules } = getCollections(db);
    const c = makeConnector({ connectorType: 'graph-mailbox' });
    await ConnectorSchedules.insertOne(c);

    const stats = await migrateToTriggerSchedules(db);
    expect(stats.connectorsFound).toBe(1);
    expect(stats.connectorsMigrated).toBe(1);

    const migrated = await TriggerSchedules.findOne({ scheduleId: c._id });
    expect(migrated?.triggerType).toBe('graph-mailbox');
    expect(migrated?.intervalMs).toBe(c.pollingIntervalMs);
    expect(migrated?.config).toEqual(c.config);
    expect(migrated?.initialPolicy).toBe('fire-existing');
  });

  it('is idempotent — re-running skips rows that already exist', async () => {
    const { TimerSchedules } = getCollections(db);
    await TimerSchedules.insertOne(makeTimer());

    const first = await migrateToTriggerSchedules(db);
    expect(first.timersMigrated).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await migrateToTriggerSchedules(db);
    expect(second.timersMigrated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('dry-run reports counts without writing', async () => {
    const { TimerSchedules, TriggerSchedules } = getCollections(db);
    await TimerSchedules.insertOne(makeTimer());

    const stats = await migrateToTriggerSchedules(db, { dryRun: true });
    expect(stats.timersMigrated).toBe(1);

    const count = await TriggerSchedules.countDocuments({});
    expect(count).toBe(0);
  });

  it('leaves source collections untouched', async () => {
    const { TimerSchedules, ConnectorSchedules } = getCollections(db);
    await TimerSchedules.insertOne(makeTimer());
    await ConnectorSchedules.insertOne(makeConnector());

    await migrateToTriggerSchedules(db);

    expect(await TimerSchedules.countDocuments({})).toBe(1);
    expect(await ConnectorSchedules.countDocuments({})).toBe(1);
  });
});
