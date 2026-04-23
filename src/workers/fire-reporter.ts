/**
 * Fire-time telemetry reporter.
 *
 * One `FireReporter` is constructed per fire in `fireClaimedSchedule` and
 * attached to `TriggerInvocation.report`. Plugins call its methods to
 * describe what they observed, fired, and dropped. When `fire()` completes
 * (successfully or by throwing) the scheduler reads the accumulated state
 * and persists a `TriggerFireEvent` — but only if the outcome was `'ok'`
 * or `'error'`. Pure no-op fires (empty delta, everything filtered, etc.)
 * skip the write entirely; the schedule's `lastFiredAt` heartbeat is the
 * liveness indicator for those.
 *
 * All methods are synchronous and best-effort. A plugin that calls nothing
 * still produces a minimal event when it ought to (outcome + duration +
 * any outer error).
 */
import type {
  TriggerFireErrorStage,
  TriggerFireEventDoc,
  TriggerFireOutcome,
} from '../db/collections';

export type FireReportError = {
  stage: TriggerFireErrorStage;
  message: string;
  httpStatus?: number;
  upstreamCode?: string;
  rawSnippet?: string;
};

/** Public interface plugins consume via `invocation.report`. */
export interface FireReporter {
  /** Add to the count of raw items inspected this fire. */
  observed(n?: number): void;

  /** Add to the fired count and optionally record the instance id. */
  fired(instanceId?: string): void;

  /** Increment a drop-reason counter. Reason keys are plugin-owned. */
  dropped(reason: string, count?: number): void;

  /**
   * Record a per-item failure. Counts as a drop with reason `'callback-error'`
   * by default and records the first error at most; subsequent calls bump
   * the counter without overwriting the sample. Pass an explicit `reason`
   * to attribute it to something other than the callback.
   */
  error(error: FireReportError, opts?: { reason?: string }): void;
}

export type FireReportSnapshot = {
  itemsObserved: number;
  itemsFired: number;
  itemsSkipped: number;
  dropReasons: Record<string, number>;
  instanceIds: string[];
  firstError: FireReportError | null;
};

/**
 * Mutable reporter the scheduler owns. Plugins only see {@link FireReporter}.
 * Methods are no-throw by contract — a buggy plugin can't destabilise the
 * fire just by mis-using the reporter.
 */
export function makeFireReporter(): FireReporter & { snapshot(): FireReportSnapshot } {
  let itemsObserved = 0;
  let itemsFired = 0;
  const instanceIds: string[] = [];
  const dropReasons: Record<string, number> = {};
  let firstError: FireReportError | null = null;

  function bump(map: Record<string, number>, key: string, by: number): void {
    map[key] = (map[key] ?? 0) + by;
  }

  return {
    observed(n = 1) {
      if (Number.isFinite(n) && n > 0) itemsObserved += n;
    },
    fired(instanceId) {
      itemsFired += 1;
      if (typeof instanceId === 'string' && instanceId.length > 0) {
        instanceIds.push(instanceId);
      }
    },
    dropped(reason, count = 1) {
      if (typeof reason !== 'string' || reason.length === 0) return;
      if (!Number.isFinite(count) || count <= 0) return;
      bump(dropReasons, reason, count);
    },
    error(error, opts) {
      const reason = opts?.reason ?? 'callback-error';
      bump(dropReasons, reason, 1);
      if (firstError === null) firstError = error;
    },
    snapshot() {
      const itemsSkipped = Object.values(dropReasons).reduce((a, b) => a + b, 0);
      return {
        itemsObserved,
        itemsFired,
        itemsSkipped,
        dropReasons: { ...dropReasons },
        instanceIds: [...instanceIds],
        firstError,
      };
    },
  };
}

/**
 * Decide the top-level outcome from a snapshot plus any outer throw.
 * See `collections.ts` → `TriggerFireOutcome` for the semantics.
 */
export function resolveFireOutcome(
  snap: FireReportSnapshot,
  outerError: FireReportError | null,
): TriggerFireOutcome {
  if (outerError) return 'error';
  if (snap.itemsFired > 0) return 'ok';
  if (snap.firstError) return 'error';
  return 'no-op';
}

/**
 * Build the persisted document. Returns `null` when the event should be
 * skipped — the scheduler calls {@link resolveFireOutcome} first and only
 * persists when the outcome is `'ok'` or `'error'`.
 */
export function buildFireEventDoc(params: {
  _id: string;
  scheduleId: string;
  definitionId: string;
  triggerType: string;
  firedAt: Date;
  durationMs: number;
  snapshot: FireReportSnapshot;
  outerError: FireReportError | null;
}): TriggerFireEventDoc | null {
  const outcome = resolveFireOutcome(params.snapshot, params.outerError);
  if (outcome === 'no-op') return null;
  const err = params.outerError ?? params.snapshot.firstError ?? null;
  const doc: TriggerFireEventDoc = {
    _id: params._id,
    scheduleId: params.scheduleId,
    definitionId: params.definitionId,
    triggerType: params.triggerType,
    firedAt: params.firedAt,
    durationMs: params.durationMs,
    outcome,
    itemsObserved: params.snapshot.itemsObserved,
    itemsFired: params.snapshot.itemsFired,
    itemsSkipped: params.snapshot.itemsSkipped,
    dropReasons: params.snapshot.dropReasons,
    instanceIds: params.snapshot.instanceIds,
  };
  // Only set `error` when there is one — avoids mongodb storing `null` or
  // undefined and makes the happy-path doc shape crisp.
  if (err) doc.error = err;
  return doc;
}
