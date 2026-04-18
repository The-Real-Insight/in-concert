/**
 * Timer worker: polls TimerSchedules for due timers, claims them with a lease,
 * starts a process instance, and advances the schedule (or marks it exhausted).
 *
 * Uses the same optimistic-claim pattern as the continuation worker.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getCollections, type TimerScheduleDoc } from '../db/collections';
import { startInstance } from '../instance/service';
import { classifyTimer, computeNextFireAfter } from './expressions';

const LEASE_MS = 30_000;

export async function claimDueTimer(db: Db): Promise<TimerScheduleDoc | null> {
  const { TimerSchedules } = getCollections(db);
  const now = new Date();
  return TimerSchedules.findOneAndUpdate(
    { status: 'ACTIVE', nextFireAt: { $lte: now } },
    {
      $set: {
        ownerId: uuidv4(),
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      },
    },
    { sort: { nextFireAt: 1 }, returnDocument: 'after' },
  );
}

export async function fireTimer(db: Db, schedule: TimerScheduleDoc): Promise<string> {
  const startingTenantId =
    typeof schedule.startingTenantId === 'string' && schedule.startingTenantId.length > 0
      ? schedule.startingTenantId
      : undefined;
  const { instanceId } = await startInstance(db, {
    commandId: uuidv4(),
    definitionId: schedule.definitionId,
    ...(startingTenantId ? { tenantId: startingTenantId } : {}),
  });
  return instanceId;
}

export async function advanceSchedule(db: Db, schedule: TimerScheduleDoc): Promise<void> {
  const { TimerSchedules } = getCollections(db);
  const now = new Date();
  const expr = classifyTimer(schedule.expression);

  const newRemaining =
    schedule.remainingReps !== null ? schedule.remainingReps - 1 : null;

  const nextFireAt = computeNextFireAfter(expr, now, newRemaining);

  if (nextFireAt === null) {
    // One-shot or bounded cycle exhausted
    await TimerSchedules.updateOne(
      { _id: schedule._id },
      {
        $set: { status: 'EXHAUSTED', lastFiredAt: now, remainingReps: newRemaining, updatedAt: now },
        $unset: { ownerId: '', leaseUntil: '' },
      },
    );
  } else {
    await TimerSchedules.updateOne(
      { _id: schedule._id },
      {
        $set: {
          nextFireAt,
          lastFiredAt: now,
          remainingReps: newRemaining,
          updatedAt: now,
        },
        $unset: { ownerId: '', leaseUntil: '' },
      },
    );
  }
}

export async function releaseTimer(db: Db, schedule: TimerScheduleDoc): Promise<void> {
  const { TimerSchedules } = getCollections(db);
  await TimerSchedules.updateOne(
    { _id: schedule._id },
    {
      $set: { updatedAt: new Date() },
      $unset: { ownerId: '', leaseUntil: '' },
    },
  );
}

export async function processOneTimer(db: Db): Promise<boolean> {
  const schedule = await claimDueTimer(db);
  if (!schedule) return false;

  try {
    const instanceId = await fireTimer(db, schedule);
    console.log(`[Timer] Fired ${schedule.expression} (def=${schedule.definitionId}) → instance ${instanceId}`);
    await advanceSchedule(db, schedule);
  } catch (err) {
    console.error(`[Timer] Fire failed for schedule ${schedule._id}:`, err);
    await releaseTimer(db, schedule);
  }
  return true;
}
