/**
 * One-shot migration: copy TimerSchedule + ConnectorSchedule rows into the
 * unified TriggerSchedule collection.
 *
 * Idempotent — safe to re-run. Uses scheduleId = old _id so repeated runs
 * overwrite (upsert) rather than duplicating.
 *
 * Does NOT delete the old collections. A follow-up migration drops them
 * after the unified collection has been validated in production.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/migrate-to-trigger-schedules.ts [--dry-run]
 */
require('dotenv').config();
process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
process.env.MONGO_DB = process.env.MONGO_DB ?? 'BPM';
process.env.MONGO_BPM_DB = process.env.MONGO_BPM_DB ?? process.env.MONGO_DB ?? 'BPM';

import { connectDb, closeDb, getDb } from '../src/db/client';
import { ensureIndexes } from '../src/db/indexes';
import {
  getCollections,
  type TimerScheduleDoc,
  type ConnectorScheduleDoc,
  type TriggerScheduleDoc,
} from '../src/db/collections';
import type { Db } from 'mongodb';

const TIMER_TRIGGER_TYPE = 'timer';

type MigrationStats = {
  timersFound: number;
  timersMigrated: number;
  connectorsFound: number;
  connectorsMigrated: number;
  skipped: number;
};

export async function migrateToTriggerSchedules(
  db: Db,
  options: { dryRun?: boolean } = {},
): Promise<MigrationStats> {
  const { TimerSchedules, ConnectorSchedules, TriggerSchedules } = getCollections(db);
  const stats: MigrationStats = {
    timersFound: 0,
    timersMigrated: 0,
    connectorsFound: 0,
    connectorsMigrated: 0,
    skipped: 0,
  };

  // --- Timers ---
  const timers = await TimerSchedules.find({}).toArray();
  stats.timersFound = timers.length;
  for (const t of timers) {
    const doc = timerToTrigger(t);
    const existing = await TriggerSchedules.findOne({ scheduleId: doc.scheduleId });
    if (existing) {
      stats.skipped++;
      continue;
    }
    if (!options.dryRun) {
      await TriggerSchedules.insertOne(doc);
    }
    stats.timersMigrated++;
  }

  // --- Connectors ---
  const connectors = await ConnectorSchedules.find({}).toArray();
  stats.connectorsFound = connectors.length;
  for (const c of connectors) {
    const doc = connectorToTrigger(c);
    const existing = await TriggerSchedules.findOne({ scheduleId: doc.scheduleId });
    if (existing) {
      stats.skipped++;
      continue;
    }
    if (!options.dryRun) {
      await TriggerSchedules.insertOne(doc);
    }
    stats.connectorsMigrated++;
  }

  return stats;
}

function timerToTrigger(t: TimerScheduleDoc): TriggerScheduleDoc {
  return {
    _id: t._id,
    scheduleId: t._id,
    definitionId: t.definitionId,
    startingTenantId: t.startingTenantId,
    startEventId: t.nodeId,
    triggerType: TIMER_TRIGGER_TYPE,
    config: {
      kind: t.kind,
      expression: t.expression,
    },
    cursor: null,
    credentials: null,
    initialPolicy: 'fire-existing',
    status: t.status,
    nextFireAt: t.nextFireAt,
    lastFiredAt: t.lastFiredAt,
    remainingReps: t.remainingReps,
    ownerId: t.ownerId,
    leaseUntil: t.leaseUntil,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function connectorToTrigger(c: ConnectorScheduleDoc): TriggerScheduleDoc {
  const status: TriggerScheduleDoc['status'] =
    c.status === 'ACTIVE' ? 'ACTIVE' : c.status === 'PAUSED' ? 'PAUSED' : 'DISABLED';
  return {
    _id: c._id,
    scheduleId: c._id,
    definitionId: c.definitionId,
    startingTenantId: c.startingTenantId,
    startEventId: c.nodeId,
    triggerType: c.connectorType,
    config: { ...c.config },
    cursor: c.cursor ?? null,
    credentials: null,
    initialPolicy: 'fire-existing',
    status,
    intervalMs: c.pollingIntervalMs,
    lastFiredAt: c.lastPolledAt,
    ownerId: c.ownerId,
    leaseUntil: c.leaseUntil,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Migrating to TriggerSchedule collection${dryRun ? ' (dry run)' : ''}…`);

  await connectDb();
  const db = getDb();
  await ensureIndexes(db);

  const stats = await migrateToTriggerSchedules(db, { dryRun });
  console.log('Done:', JSON.stringify(stats, null, 2));

  await closeDb();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
