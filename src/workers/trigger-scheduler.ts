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
 *   - TriggerSchedule.lastError, retryAfter and consecutiveFailures cleared
 *
 * Either everything lands or nothing does; a crash mid-fire leaves the
 * schedule unchanged and the sweeper reclaims the lease.
 */
import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { CLEAR_RETRY_BACKOFF, getCollections, type TriggerScheduleDoc } from '../db/collections';
import { startInstance } from '../instance/service';
import type { TriggerRegistry } from '../triggers/registry';
import type {
  StartTrigger,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../triggers/types';
import {
  buildFireEventDoc,
  makeFireReporter,
  type FireReportError,
} from './fire-reporter';

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
    $and: [
      {
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
      },
      // A failed fire leaves the due-clauses above permanently true — see `retryAfter`
      // on TriggerScheduleDoc — so it is gated separately rather than by overloading them.
      { $or: [{ retryAfter: { $exists: false } }, { retryAfter: { $lte: now } }] },
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
    const msg = `No trigger registered for type "${schedule.triggerType}"`;
    await recordFireError(db, schedule, msg);
    await writeFireEvent(db, schedule, {
      firedAt: new Date(),
      durationMs: 0,
      snapshot: {
        itemsObserved: 0,
        itemsFired: 0,
        itemsSkipped: 0,
        dropReasons: {},
        instanceIds: [],
        firstError: null,
      },
      outerError: { stage: 'unknown', message: msg },
    });
    return null;
  }

  const def: TriggerDefinition = {
    triggerType: schedule.triggerType,
    definitionId: schedule.definitionId,
    startEventId: schedule.startEventId,
    config: schedule.config,
  };

  const reporter = makeFireReporter();
  const invocation: TriggerInvocation = {
    scheduleId: schedule.scheduleId,
    definition: def,
    cursor: schedule.cursor,
    credentials: schedule.credentials,
    now: new Date(),
    db,
    startingTenantId: schedule.startingTenantId,
    report: reporter,
  };

  const firedAt = new Date();
  const started = Date.now();
  let result: TriggerResult | null = null;
  let outerError: FireReportError | null = null;
  try {
    result = await trigger.fire(invocation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    outerError = {
      stage: 'fire',
      message: msg,
      rawSnippet: stack ? stack.slice(0, 500) : undefined,
    };
    await recordFireError(db, schedule, msg);
  }

  // Persist instances first so the reporter reflects actual created counts
  // for StartRequest-style plugins (graph-mailbox and sharepoint-folder
  // populate the reporter themselves inside fire(); timer and ai-listener
  // return StartRequest[] and rely on the scheduler for persistence).
  let fireOutcome: FireOutcome | null = null;
  if (result) {
    try {
      fireOutcome = await persistFireResult(db, trigger, schedule, result, reporter);
    } catch (persistErr) {
      const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      outerError = outerError ?? {
        stage: 'fire',
        message: `persistFireResult failed: ${msg}`,
      };
    }
  }

  const durationMs = Date.now() - started;
  try {
    await writeFireEvent(db, schedule, {
      firedAt,
      durationMs,
      snapshot: reporter.snapshot(),
      outerError,
    });
  } catch (writeErr) {
    // Telemetry must never affect the fire path. Swallow and log.
    // eslint-disable-next-line no-console
    console.error('[trigger-scheduler] Failed to write TriggerFireEvent:', writeErr);
  }

  return fireOutcome;
}

async function writeFireEvent(
  db: Db,
  schedule: TriggerScheduleDoc,
  params: {
    firedAt: Date;
    durationMs: number;
    snapshot: ReturnType<ReturnType<typeof makeFireReporter>['snapshot']>;
    outerError: FireReportError | null;
  },
): Promise<void> {
  const doc = buildFireEventDoc({
    _id: uuidv4(),
    scheduleId: schedule.scheduleId,
    definitionId: schedule.definitionId,
    triggerType: schedule.triggerType,
    firedAt: params.firedAt,
    durationMs: params.durationMs,
    snapshot: params.snapshot,
    outerError: params.outerError,
  });
  if (doc === null) return; // no-op fire; heartbeat via schedule.lastFiredAt is enough
  const { TriggerFireEvents } = getCollections(db);
  await TriggerFireEvents.insertOne(doc);
}

async function persistFireResult(
  db: Db,
  trigger: StartTrigger,
  schedule: TriggerScheduleDoc,
  result: TriggerResult,
  reporter: ReturnType<typeof makeFireReporter> | null,
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
    // Feed the reporter observed-items count for StartRequest-style plugins
    // that didn't populate it themselves (inline-creating plugins populate
    // the reporter from inside fire() and return starts: []).
    if (reporter && result.starts.length > 0 && reporter.snapshot().itemsObserved === 0) {
      reporter.observed(result.starts.length);
    }
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
            reporter?.dropped('already-processed');
          } else {
            createdCount++;
            reporter?.fired(res.instanceId);
          }
        }

        // 2. Schedule update — cursor, timing, clear error, release lease.
        const update: Record<string, unknown> = {
          cursor: result.nextCursor,
          lastFiredAt: now,
          updatedAt: now,
        };
        const unset: Record<string, ''> = {
          ownerId: '',
          leaseUntil: '',
          ...CLEAR_RETRY_BACKOFF,
        };

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

/**
 * Back off after a failed fire.
 *
 * Without this a broken schedule is re-fired as fast as the worker loops. `lastFiredAt` is the
 * anchor the interval form is measured from and means "last **successful** fire", so a failure
 * never advances it and `now - lastFiredAt >= intervalMs` stays true forever; the lease is
 * released immediately, so the very next tick claims the same row again. The fire-at form fails
 * the same way — an un-advanced `nextFireAt` also stays `<= now`. Measured on production: an RSS
 * schedule configured at `intervalMs: 60_000` fired **1,182,831 times in 24 h** (~14/s, ~820×
 * its interval), every one of them the same failed fetch, each writing a TriggerFireEvent —
 * 4.87M rows in a fortnight.
 *
 * The delay doubles per consecutive failure and is never shorter than the schedule's own
 * interval, so backing off can only ever slow a schedule down, never speed it up.
 */
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 30 * 60_000;

export function computeRetryDelayMs(
  consecutiveFailures: number,
  intervalMs?: number,
): number {
  const attempt = Math.max(1, consecutiveFailures);
  // 2 ** 30 already exceeds the cap; clamping the exponent keeps it finite for absurd counts.
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 30));
  // The interval is applied *after* the cap, not before: a schedule that normally polls once a
  // day must not start retrying every 30 minutes because it failed.
  return Math.max(exponential, intervalMs ?? 0);
}

async function recordFireError(
  db: Db,
  schedule: TriggerScheduleDoc,
  message: string,
): Promise<void> {
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();
  const failures = (schedule.consecutiveFailures ?? 0) + 1;
  const retryAfter = new Date(
    now.getTime() + computeRetryDelayMs(failures, schedule.intervalMs),
  );
  await TriggerSchedules.updateOne(
    { _id: schedule._id },
    {
      $set: {
        lastError: message,
        consecutiveFailures: failures,
        retryAfter,
        updatedAt: now,
      },
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
