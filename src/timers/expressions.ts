/**
 * Timer expression parser for BPMN timer start events.
 *
 * Supports:
 * - ISO 8601 duration:           PT30M, P1DT2H, PT10S
 * - ISO 8601 repeating interval: R/PT1H (unbounded), R3/PT10M (bounded)
 * - ISO 8601 date-time:          2026-04-16T09:00:00Z
 * - Cron expressions (5-field):  0 * * * * (every hour), 30 8 * * 1-5 (8:30 weekdays)
 */

// ── ISO 8601 duration ────────────────────────────────────────────────────────

const ISO_DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export interface ParsedDuration {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function parseDuration(iso: string): ParsedDuration {
  const m = iso.match(ISO_DURATION_RE);
  if (!m) throw new Error(`Invalid ISO 8601 duration: ${iso}`);
  return {
    years: parseInt(m[1] ?? '0', 10),
    months: parseInt(m[2] ?? '0', 10),
    days: parseInt(m[3] ?? '0', 10),
    hours: parseInt(m[4] ?? '0', 10),
    minutes: parseInt(m[5] ?? '0', 10),
    seconds: parseFloat(m[6] ?? '0'),
  };
}

export function addDuration(base: Date, dur: ParsedDuration): Date {
  const d = new Date(base);
  if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + dur.years);
  if (dur.months) d.setUTCMonth(d.getUTCMonth() + dur.months);
  if (dur.days) d.setUTCDate(d.getUTCDate() + dur.days);
  if (dur.hours) d.setUTCHours(d.getUTCHours() + dur.hours);
  if (dur.minutes) d.setUTCMinutes(d.getUTCMinutes() + dur.minutes);
  if (dur.seconds) d.setUTCMilliseconds(d.getUTCMilliseconds() + dur.seconds * 1000);
  return d;
}

export function durationToMs(dur: ParsedDuration): number {
  return (
    dur.seconds * 1_000 +
    dur.minutes * 60_000 +
    dur.hours * 3_600_000 +
    dur.days * 86_400_000
  );
  // years/months are approximate — only used for simple display, not scheduling
}

// ── ISO 8601 repeating interval ──────────────────────────────────────────────

const REPEAT_RE = /^R(\d*)\/(.+)$/;

export interface ParsedRepeat {
  repetitions: number | null; // null = unbounded
  duration: ParsedDuration;
}

export function parseRepeat(expr: string): ParsedRepeat {
  const m = expr.match(REPEAT_RE);
  if (!m) throw new Error(`Invalid ISO 8601 repeating interval: ${expr}`);
  const reps = m[1] === '' ? null : parseInt(m[1], 10);
  return { repetitions: reps, duration: parseDuration(m[2]) };
}

// ── Cron (5-field) ───────────────────────────────────────────────────────────

interface CronField {
  values: number[] | null; // null = wildcard (any)
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const CRON_RANGES: [number, number][] = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week (0=Sun)
];

function parseCronField(field: string, min: number, max: number): CronField {
  if (field === '*') return { values: null };
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const rangePart = stepMatch ? stepMatch[1] : part;

    if (rangePart === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
    } else {
      const rangeMatch = rangePart.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        for (let i = lo; i <= hi; i += step) values.add(i);
      } else {
        values.add(parseInt(rangePart, 10));
      }
    }
  }

  return { values: Array.from(values).sort((a, b) => a - b) };
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): ${expr}`);
  return {
    minute: parseCronField(parts[0], ...CRON_RANGES[0]),
    hour: parseCronField(parts[1], ...CRON_RANGES[1]),
    dayOfMonth: parseCronField(parts[2], ...CRON_RANGES[2]),
    month: parseCronField(parts[3], ...CRON_RANGES[3]),
    dayOfWeek: parseCronField(parts[4], ...CRON_RANGES[4]),
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.values === null || field.values.includes(value);
}

/**
 * Find the next fire time strictly after `after` for the given cron schedule.
 * Searches up to 2 years ahead to avoid infinite loops on impossible schedules.
 */
export function nextCronFire(cron: ParsedCron, after: Date): Date {
  const d = new Date(after);
  // Start from the next minute
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  const limit = new Date(after);
  limit.setUTCFullYear(limit.getUTCFullYear() + 2);

  while (d < limit) {
    if (
      fieldMatches(cron.month, d.getUTCMonth() + 1) &&
      fieldMatches(cron.dayOfMonth, d.getUTCDate()) &&
      fieldMatches(cron.dayOfWeek, d.getUTCDay()) &&
      fieldMatches(cron.hour, d.getUTCHours()) &&
      fieldMatches(cron.minute, d.getUTCMinutes())
    ) {
      return d;
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }

  throw new Error('No matching cron fire time within 2 years');
}

// ── Timer expression classification ──────────────────────────────────────────

export type TimerKind = 'cycle' | 'date' | 'duration' | 'cron';

export interface TimerExpression {
  kind: TimerKind;
  raw: string;
}

/**
 * Classify a timer expression string.
 */
export function classifyTimer(expr: string): TimerExpression {
  const s = expr.trim();
  if (REPEAT_RE.test(s)) return { kind: 'cycle', raw: s };
  if (ISO_DURATION_RE.test(s)) return { kind: 'duration', raw: s };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { kind: 'date', raw: s };
  // Assume cron if it has 5 whitespace-separated fields
  if (s.split(/\s+/).length === 5) return { kind: 'cron', raw: s };
  throw new Error(`Unrecognised timer expression: ${s}`);
}

/**
 * Compute the first fire time for a timer expression.
 * `referenceTime` is typically deployedAt (for duration) or now (for cycle/cron).
 */
export function computeNextFire(expr: TimerExpression, referenceTime: Date): Date {
  switch (expr.kind) {
    case 'date':
      return new Date(expr.raw);

    case 'duration':
      return addDuration(referenceTime, parseDuration(expr.raw));

    case 'cycle': {
      const rep = parseRepeat(expr.raw);
      return addDuration(referenceTime, rep.duration);
    }

    case 'cron':
      return nextCronFire(parseCron(expr.raw), referenceTime);

    default:
      throw new Error(`Unknown timer kind: ${(expr as TimerExpression).kind}`);
  }
}

/**
 * After a timer has fired, compute the next fire time (or null if exhausted).
 * `remainingReps` is only relevant for bounded cycles (R3/PT10M).
 */
export function computeNextFireAfter(
  expr: TimerExpression,
  firedAt: Date,
  remainingReps: number | null,
): Date | null {
  switch (expr.kind) {
    case 'date':
    case 'duration':
      return null; // one-shot

    case 'cycle': {
      if (remainingReps !== null && remainingReps <= 0) return null;
      const rep = parseRepeat(expr.raw);
      return addDuration(firedAt, rep.duration);
    }

    case 'cron':
      return nextCronFire(parseCron(expr.raw), firedAt);

    default:
      return null;
  }
}
