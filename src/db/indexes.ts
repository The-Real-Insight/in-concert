import { Db } from 'mongodb';
import { COLLECTION_NAMES } from './collections';

export async function ensureIndexes(db: Db): Promise<void> {
  await db
    .collection(COLLECTION_NAMES.ProcessInstanceEvent)
    .createIndex({ instanceId: 1, seq: 1 }, { unique: true });

  await db
    .collection(COLLECTION_NAMES.Continuation)
    .createIndex({ status: 1, dueAt: 1 });

  await db
    .collection(COLLECTION_NAMES.Continuation)
    .createIndex({ instanceId: 1 });

  await db
    .collection(COLLECTION_NAMES.Outbox)
    .createIndex({ status: 1, nextAttemptAt: 1 });

  await db
    .collection(COLLECTION_NAMES.ProcessDefinition)
    .createIndex({ id: 1, version: 1 }, { unique: true });

  await db
    .collection(COLLECTION_NAMES.HumanTask)
    .createIndex({ status: 1, assigneeUserId: 1, createdAt: -1 });

  await db
    .collection(COLLECTION_NAMES.HumanTask)
    .createIndex({ status: 1, candidateRoles: 1, createdAt: -1 });

  await db
    .collection(COLLECTION_NAMES.HumanTask)
    .createIndex({ status: 1, roleId: 1, createdAt: -1 });

  await db
    .collection(COLLECTION_NAMES.HumanTask)
    .createIndex({ status: 1, assigneeUserId: 1, roleId: 1, createdAt: -1 });

  await db
    .collection(COLLECTION_NAMES.HumanTask)
    .createIndex({ instanceId: 1 });

  await db
    .collection(COLLECTION_NAMES.ProcessInstanceHistory)
    .createIndex({ instanceId: 1, seq: 1 });

  await db
    .collection(COLLECTION_NAMES.TimerSchedule)
    .createIndex({ status: 1, nextFireAt: 1 });

  await db
    .collection(COLLECTION_NAMES.TimerSchedule)
    .createIndex({ definitionId: 1, nodeId: 1 }, { unique: true });

  await db
    .collection(COLLECTION_NAMES.ConnectorSchedule)
    .createIndex({ status: 1 });

  await db
    .collection(COLLECTION_NAMES.ConnectorSchedule)
    .createIndex({ definitionId: 1, nodeId: 1 }, { unique: true });

  // Idempotency: two starts with the same (definitionId, idempotencyKey)
  // collapse to one instance. Partial filter so this never conflicts with
  // instances that don't set a key (e.g. user-initiated starts).
  await db
    .collection(COLLECTION_NAMES.ProcessInstance)
    .createIndex(
      { definitionId: 1, idempotencyKey: 1 },
      {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $exists: true } },
      },
    );

  // Unified trigger schedules (replaces TimerSchedule + ConnectorSchedule).
  await db
    .collection(COLLECTION_NAMES.TriggerSchedule)
    .createIndex({ scheduleId: 1 }, { unique: true });

  // Per-tenant uniqueness: a single workflow may have one schedule per
  // start event PER tenant. Two tenants running the same workflow get
  // independent schedule rows (each with their own credentials, cursor,
  // and fire state). The legacy `(definitionId, startEventId)` unique
  // index is dropped if present — it collided with per-tenant rows.
  const triggerSchedules = db.collection(COLLECTION_NAMES.TriggerSchedule);
  try {
    await triggerSchedules.dropIndex('definitionId_1_startEventId_1');
  } catch (_err) {
    /* index doesn't exist on fresh DBs — fine */
  }
  await triggerSchedules.createIndex(
    { definitionId: 1, startEventId: 1, startingTenantId: 1 },
    { unique: true },
  );

  await db
    .collection(COLLECTION_NAMES.TriggerSchedule)
    .createIndex({ triggerType: 1, status: 1, nextFireAt: 1 });

  await db
    .collection(COLLECTION_NAMES.TriggerSchedule)
    .createIndex({ triggerType: 1, status: 1, lastFiredAt: 1 });

  // TriggerFireEvent — telemetry for operator diagnostics.
  //   List-by-schedule descending: the portal's expand panel reads this.
  //   TTL: auto-expire rows after the configured retention.
  await db
    .collection(COLLECTION_NAMES.TriggerFireEvent)
    .createIndex({ scheduleId: 1, firedAt: -1 });

  const ttlDays = parseInt(process.env.IN_CONCERT_FIRE_EVENTS_TTL_DAYS ?? '14', 10);
  const ttlSeconds = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14) * 24 * 60 * 60;
  await db
    .collection(COLLECTION_NAMES.TriggerFireEvent)
    .createIndex({ firedAt: 1 }, { expireAfterSeconds: ttlSeconds });
}
