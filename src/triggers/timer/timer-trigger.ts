/**
 * Timer trigger plugin. Implements the StartTrigger interface over the
 * existing expression parser (src/timers/expressions.ts). Supports every
 * format the pre-refactor timer worker did: ISO 8601 durations,
 * repeating intervals (R/PT10M, R3/PT10M), date-times, 5-field cron,
 * and RFC 5545 RRULE.
 *
 * State model:
 *   - The schedule row's `nextFireAt` is the next scheduled fire time.
 *   - The cursor carries `remainingReps` for bounded cycles (R3/PT10M).
 *   - Each fire produces exactly one StartRequest. `dedupKey` is the
 *     nextFireAt ISO string, so a crash-and-retry of the same logical
 *     fire idempotently collapses to one process instance.
 */
import {
  classifyTimer,
  computeNextFire,
  computeNextFireAfter,
  parseRepeat,
  type TimerExpression,
} from '../../timers/expressions';
import type {
  BpmnClaim,
  BpmnStartEventView,
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../types';

export const TIMER_TRIGGER_TYPE = 'timer';

type TimerCursor = { remainingReps: number | null } | null;

function encodeCursor(c: TimerCursor): TriggerCursor {
  return c === null ? null : JSON.stringify(c);
}

function decodeCursor(c: TriggerCursor): TimerCursor {
  if (c === null) return null;
  try {
    return JSON.parse(c) as TimerCursor;
  } catch {
    return null;
  }
}

function classifyFromDef(def: TriggerDefinition): TimerExpression {
  const expression = def.config['expression'];
  if (typeof expression !== 'string' || expression.length === 0) {
    throw new Error('Timer config missing "expression"');
  }
  return classifyTimer(expression);
}

export class TimerTrigger implements StartTrigger {
  readonly triggerType = TIMER_TRIGGER_TYPE;
  readonly defaultInitialPolicy = 'fire-existing' as const;
  readonly deployStatus = 'ACTIVE' as const;

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    if (!event.timerDefinition) return null;
    return { config: { expression: event.timerDefinition } };
  }

  validate(def: TriggerDefinition): void {
    classifyFromDef(def);
  }

  nextSchedule(
    def: TriggerDefinition,
    lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    const expr = classifyFromDef(def);
    const reference = lastFiredAt ?? new Date();
    const next =
      lastFiredAt === null
        ? computeNextFire(expr, reference)
        : (computeNextFireAfter(expr, reference, null) ?? computeNextFire(expr, reference));
    return { kind: 'fire-at', at: next };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    const expr = classifyFromDef(invocation.definition);
    const cursor = decodeCursor(invocation.cursor);

    // Seed remainingReps on the first fire of a bounded cycle.
    let remainingReps: number | null;
    if (cursor !== null) {
      remainingReps = cursor.remainingReps;
    } else if (expr.kind === 'cycle') {
      remainingReps = parseRepeat(expr.raw).repetitions;
    } else {
      remainingReps = null;
    }

    // Consume one rep for this fire.
    const remainingAfter = remainingReps === null ? null : remainingReps - 1;

    // Stable dedupKey for this logical fire — the "now" the scheduler
    // claimed us at. A crash-and-retry sees the same `now` because the
    // scheduler row's nextFireAt hasn't advanced yet (the prior txn
    // rolled back), so the scheduler re-fires the same slot and invocation.now
    // re-aligns. We use ISO seconds to avoid millisecond drift between retries.
    const dedupKey = invocation.now.toISOString().slice(0, 19);

    const starts = [
      {
        dedupKey,
        payload: {
          timer: {
            firedAt: invocation.now.toISOString(),
            kind: expr.kind,
            expression: expr.raw,
          },
        },
      },
    ];

    const nextFire = computeNextFireAfter(expr, invocation.now, remainingAfter);

    if (!nextFire) {
      return {
        starts,
        nextCursor: encodeCursor({ remainingReps: remainingAfter }),
        exhausted: true,
      };
    }

    return {
      starts,
      nextCursor: encodeCursor({ remainingReps: remainingAfter }),
      nextFireAt: nextFire,
    };
  }
}
