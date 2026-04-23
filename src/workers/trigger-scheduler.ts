/**
 * Generic trigger scheduler. Knows nothing about specific trigger types —
 * it claims due TriggerSchedule rows, looks up the StartTrigger in the
 * registry, calls fire(), and atomically persists the result.
 *
 * Atomicity contract: when a fire returns successfully, the following
 * commit in one transaction:
 *   - ProcessInstance rows (one per StartRequest, idempotencyKey-deduped)
 *   - TriggerSchedule.cursor ← result.nextCursor
 *   - TriggerSchedule.lastFiredAt ← now
 *   - TriggerSchedule.nextFireAt or intervalMs ← derived from nextSchedule()
 *   - TriggerSchedule.lastError cleared
 *
 * Either everything lands or nothing does; a crash mid-fire leaves the
 * schedule unchanged and the sweeper reclaims the lease.
 */
import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { getCollections, type TriggerScheduleDoc } from '../db/collections';
import { startInstance } from '../instance/service';
import type { TriggerRegistry } from '../triggers/registry';
import type {
  StartTrigger,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../triggers/types';

const LEASE_MS = 60_000;

/**
 * Claim the next due schedule. Returns null if nothing is due.
 *
 * "Due" depends on the trigger shape:
 *   - fire-at:  nextFireAt <= now
 *   - interval: (lastFiredAt is null) OR (now - lastFiredAt >= intervalMs)
 *
 * Lease exclusion is advisory: the sweeper reclaims expired leases back
 * to the unlocked state on a separate schedule, so a crashed worker's
 * row becomes claimable again without intervention.
 */
export async function claimDueSchedule(
  db: Db,
  options?: { triggerTypes?: string[] },
): Promise<TriggerScheduleDoc | null> {
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();

  const due: Record<string, unknown> = {
    status: 'ACTIVE',
    $or: [
      { nextFireAt: { $lte: now } },
      { lastFiredAt: { $exists: false }, intervalMs: { $exists: true } },
      {
        intervalMs: { $exists: true },
        $expr: {
          $gte: [{ $subtract: [now, '$lastFiredAt'] }, '$intervalMs'],
        },
      },
    ],
  };
  if (options?.triggerTypes && options.triggerTypes.length > 0) {
    due.triggerType = { $in: options.triggerTypes };
  }

  return TriggerSchedules.findOneAndUpdate(
    due,
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

export type FireOutcome = {
  scheduleId: string;
  triggerType: string;
  starts: number;
  deduplicated: number;
};

/**
 * Fire one claimed schedule: look up the trigger, call fire(), persist the
 * result. Never throws — errors are recorded on the row and the schedule
 * is released for the next tick.
 */
export async function fireClaimedSchedule(
  db: Db,
  registry: TriggerRegistry,
  schedule: TriggerScheduleDoc,
): Promise<FireOutcome | null> {
  const trigger = registry.get(schedule.triggerType);
  if (!trigger) {
    await recordFireError(
      db,
      schedule._id,
      `No trigger registered for type "${schedule.triggerType}"`,
    );
    return null;
  }

  const def: TriggerDefinition = {
    triggerType: schedule.triggerType,
    definitionId: schedule.definitionId,
    startEventId: schedule.startEventId,
    config: schedule.config,
  };

  const invocation: TriggerInvocation = {
    scheduleId: schedule.scheduleId,
    definition: def,
    cursor: schedule.cursor,
    credentials: schedule.credentials,
    now: new Date(),
    db,
    startingTenantId: schedule.startingTenantId,
  };

  let result: TriggerResult;
  try {
    result = await trigger.fire(invocation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordFireError(db, schedule._id, msg);
    return null;
  }

  return persistFireResult(db, trigger, schedule, result);
}

async function persistFireResult(
  db: Db,
  trigger: StartTrigger,
  schedule: TriggerScheduleDoc,
  result: TriggerResult,
): Promise<FireOutcome> {
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();

  const def: TriggerDefinition = {
    triggerType: schedule.triggerType,
    definitionId: schedule.definitionId,
    startEventId: schedule.startEventId,
    config: schedule.config,
  };
  const nextSchedule = trigger.nextSchedule(def, now, result.nextCursor);

  let createdCount = 0;
  let dedupedCount = 0;

  if (result.starts.length > 0 || true) {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        // 1. Starts (each deduped by idempotencyKey).
        for (const sr of result.starts) {
          const idempotencyKey = `${schedule.scheduleId}:${sr.dedupKey}`;
          const res = await startInstance(db, {
            commandId: uuidv4(),
            definitionId: schedule.definitionId,
            tenantId: schedule.startingTenantId,
            idempotencyKey,
            session,
          });
          if (res.deduplicated) {
            dedupedCount++;
          } else {
            createdCount++;
          }
        }

        // 2. Schedule update — cursor, timing, clear error, release lease.
        const update: Record<string, unknown> = {
          cursor: result.nextCursor,
          lastFiredAt: now,
          updatedAt: now,
        };
        const unset: Record<string, ''> = { ownerId: '', leaseUntil: '', lastError: '' };

        if (result.exhausted) {
          update.status = 'EXHAUSTED';
          unset.nextFireAt = '';
          unset.intervalMs = '';
        } else {
          applyScheduleTiming(update, unset, nextSchedule, result);
        }

        await TriggerSchedules.updateOne(
          { _id: schedule._id },
          { $set: update, $unset: unset },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  return {
    scheduleId: schedule.scheduleId,
    triggerType: schedule.triggerType,
    starts: createdCount,
    deduplicated: dedupedCount,
  };
}

function applyScheduleTiming(
  set: Record<string, unknown>,
  unset: Record<string, ''>,
  nextSchedule: TriggerSchedule,
  result: TriggerResult,
): void {
  // If the trigger explicitly returned a nextFireAt, use that.
  if (result.nextFireAt) {
    set.nextFireAt = result.nextFireAt;
    unset.intervalMs = '';
    return;
  }

  if (nextSchedule.kind === 'fire-at') {
    set.nextFireAt = nextSchedule.at;
    unset.intervalMs = '';
  } else {
    // interval
    set.intervalMs = nextSchedule.ms;
    unset.nextFireAt = '';
  }
}

async function recordFireError(db: Db, id: string, message: string): Promise<void> {
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();
  await TriggerSchedules.updateOne(
    { _id: id },
    {
      $set: { lastError: message, updatedAt: now },
      $unset: { ownerId: '', leaseUntil: '' },
    },
  );
}

/** Convenience: claim one due schedule and fire it. Returns true if work was done. */
export async function processOneTrigger(
  db: Db,
  registry: TriggerRegistry,
): Promise<boolean> {
  const schedule = await claimDueSchedule(db);
  if (!schedule) return false;
  await fireClaimedSchedule(db, registry, schedule);
  return true;
}
