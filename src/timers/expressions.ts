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

// ── RRULE (RFC 5545 subset) ──────────────────────────────────────────────────

export interface ParsedRRule {
  dtstart: Date;
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay: string[] | null;       // ['MO','WE','FR']
  byMonthDay: number[] | null;  // [15]
  byMonth: number[] | null;     // [1..12]
  bySetPos: number[] | null;    // [1], [-1], [2]
  count: number | null;
  until: Date | null;
}

const RRULE_DAY_MAP: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRRule(expr: string): ParsedRRule {
  // Accept newline or semicolon between DTSTART and RRULE
  const lines = expr.replace(/\r/g, '').split(/\n|;(?=RRULE:)/);
  let dtstartStr = '';
  let rruleLine = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('DTSTART:')) dtstartStr = trimmed.slice(8);
    else if (trimmed.startsWith('RRULE:')) rruleLine = trimmed.slice(6);
  }
  if (!rruleLine) throw new Error(`Invalid RRULE expression: ${expr}`);

  const dtstart = dtstartStr ? new Date(
    dtstartStr.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z')
  ) : new Date();

  const params: Record<string, string> = {};
  for (const part of rruleLine.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) params[k] = v;
  }

  const freq = params.FREQ as ParsedRRule['freq'];
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq))
    throw new Error(`Unsupported RRULE FREQ: ${params.FREQ}`);

  return {
    dtstart,
    freq,
    interval: params.INTERVAL ? parseInt(params.INTERVAL, 10) : 1,
    byDay: params.BYDAY ? params.BYDAY.split(',') : null,
    byMonthDay: params.BYMONTHDAY ? params.BYMONTHDAY.split(',').map(Number) : null,
    byMonth: params.BYMONTH ? params.BYMONTH.split(',').map(Number) : null,
    bySetPos: params.BYSETPOS ? params.BYSETPOS.split(',').map(Number) : null,
    count: params.COUNT ? parseInt(params.COUNT, 10) : null,
    until: params.UNTIL ? new Date(
      params.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z')
    ) : null,
  };
}

/** Get all days in a month (1-based) matching specific weekdays. */
function weekdayOccurrencesInMonth(year: number, month0: number, dayNums: number[]): number[] {
  const days: number[] = [];
  const d = new Date(Date.UTC(year, month0, 1));
  while (d.getUTCMonth() === month0) {
    if (dayNums.includes(d.getUTCDay())) days.push(d.getUTCDate());
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/** Resolve BYDAY strings to day-of-week numbers. Handles special 'weekday'/'weekend day' groups. */
function resolveDayNums(byDay: string[]): number[] {
  const result: number[] = [];
  for (const d of byDay) {
    const upper = d.toUpperCase();
    if (RRULE_DAY_MAP[upper] != null) result.push(RRULE_DAY_MAP[upper]);
    // Support weekday/weekend day groups if encoded
  }
  return result;
}

/**
 * Find the next fire time strictly after `after` for an RRULE schedule.
 * Returns null if exhausted (COUNT/UNTIL).
 */
export function nextRRuleFire(rrule: ParsedRRule, after: Date): Date | null {
  const { dtstart, freq, interval, byDay, byMonthDay, byMonth, bySetPos, count, until } = rrule;
  const h = dtstart.getUTCHours(), m = dtstart.getUTCMinutes(), s = dtstart.getUTCSeconds();

  // Generate candidate dates forward from dtstart, yield the first one strictly after `after`.
  // Safety limit: 1500 iterations (covers >4 years of daily, >28 years of monthly).
  let occurrenceCount = 0;

  // ── DAILY ──
  if (freq === 'DAILY') {
    const d = new Date(dtstart);
    // Jump ahead close to `after`
    if (d <= after) {
      const diffDays = Math.floor((after.getTime() - d.getTime()) / 86400000);
      const periods = Math.floor(diffDays / interval);
      d.setUTCDate(d.getUTCDate() + periods * interval);
    }
    for (let i = 0; i < 1500; i++) {
      if (d > after) {
        occurrenceCount++;
        if (count != null && occurrenceCount > count) return null;
        if (until && d > until) return null;
        return d;
      }
      d.setUTCDate(d.getUTCDate() + interval);
      // Count from dtstart for COUNT
      occurrenceCount = Math.floor((d.getTime() - dtstart.getTime()) / (interval * 86400000));
    }
    return null;
  }

  // ── WEEKLY ──
  if (freq === 'WEEKLY') {
    const dayNums = byDay ? resolveDayNums(byDay) : [dtstart.getUTCDay()];
    // Start from dtstart, advance week by week
    const weekStart = new Date(dtstart);
    // Jump ahead
    if (weekStart <= after) {
      const diffWeeks = Math.floor((after.getTime() - weekStart.getTime()) / (7 * 86400000 * interval));
      weekStart.setUTCDate(weekStart.getUTCDate() + diffWeeks * interval * 7);
    }
    occurrenceCount = 0;
    for (let w = 0; w < 1500; w++) {
      // Generate all matching days in this week-window
      for (let dayOff = 0; dayOff < 7; dayOff++) {
        const candidate = new Date(weekStart);
        candidate.setUTCDate(candidate.getUTCDate() + dayOff);
        candidate.setUTCHours(h, m, s, 0);
        if (dayNums.includes(candidate.getUTCDay()) && candidate > after) {
          occurrenceCount++;
          if (count != null && occurrenceCount > count) return null;
          if (until && candidate > until) return null;
          return candidate;
        }
      }
      weekStart.setUTCDate(weekStart.getUTCDate() + interval * 7);
    }
    return null;
  }

  // ── MONTHLY ──
  if (freq === 'MONTHLY') {
    let year = dtstart.getUTCFullYear();
    let month0 = dtstart.getUTCMonth();
    // Jump ahead
    if (new Date(Date.UTC(year, month0 + 1, 0, h, m, s)) <= after) {
      const dtMonth = dtstart.getUTCFullYear() * 12 + dtstart.getUTCMonth();
      const afterMonth = after.getUTCFullYear() * 12 + after.getUTCMonth();
      const diff = afterMonth - dtMonth;
      const periods = Math.floor(diff / interval);
      month0 += periods * interval;
      year = dtstart.getUTCFullYear() + Math.floor(month0 / 12);
      month0 = month0 % 12;
    }
    occurrenceCount = 0;
    for (let i = 0; i < 1500; i++) {
      const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

      let candidateDays: number[] = [];
      if (byDay && bySetPos) {
        // Relative: "the Nth [weekday] of the month"
        const dayNums = resolveDayNums(byDay);
        const allOccurrences = weekdayOccurrencesInMonth(year, month0, dayNums);
        for (const pos of bySetPos) {
          const idx = pos > 0 ? pos - 1 : allOccurrences.length + pos;
          if (idx >= 0 && idx < allOccurrences.length) candidateDays.push(allOccurrences[idx]);
        }
      } else if (byMonthDay) {
        // Absolute: specific day(s) of month
        for (const d of byMonthDay) {
          if (d <= daysInMonth) candidateDays.push(d);
        }
      } else {
        // Default: same day as dtstart
        const dd = dtstart.getUTCDate();
        if (dd <= daysInMonth) candidateDays.push(dd);
      }

      candidateDays.sort((a, b) => a - b);
      for (const day of candidateDays) {
        const candidate = new Date(Date.UTC(year, month0, day, h, m, s));
        if (candidate.getUTCMonth() !== month0) continue; // overflow guard
        if (candidate > after) {
          occurrenceCount++;
          if (count != null && occurrenceCount > count) return null;
          if (until && candidate > until) return null;
          return candidate;
        }
      }

      month0 += interval;
      year += Math.floor(month0 / 12);
      month0 = month0 % 12;
    }
    return null;
  }

  // ── YEARLY ──
  if (freq === 'YEARLY') {
    let year = dtstart.getUTCFullYear();
    if (new Date(Date.UTC(year, 11, 31, h, m, s)) <= after) {
      const diff = after.getUTCFullYear() - year;
      const periods = Math.floor(diff / interval);
      year += periods * interval;
    }
    const months = byMonth ? byMonth.map(m0 => m0 - 1) : [dtstart.getUTCMonth()];
    occurrenceCount = 0;
    for (let i = 0; i < 1500; i++) {
      for (const month0 of months) {
        const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

        let candidateDays: number[] = [];
        if (byDay && bySetPos) {
          const dayNums = resolveDayNums(byDay);
          const allOccurrences = weekdayOccurrencesInMonth(year, month0, dayNums);
          for (const pos of bySetPos) {
            const idx = pos > 0 ? pos - 1 : allOccurrences.length + pos;
            if (idx >= 0 && idx < allOccurrences.length) candidateDays.push(allOccurrences[idx]);
          }
        } else if (byMonthDay) {
          for (const d of byMonthDay) {
            if (d <= daysInMonth) candidateDays.push(d);
          }
        } else {
          const dd = dtstart.getUTCDate();
          if (dd <= daysInMonth) candidateDays.push(dd);
        }

        candidateDays.sort((a, b) => a - b);
        for (const day of candidateDays) {
          const candidate = new Date(Date.UTC(year, month0, day, h, m, s));
          if (candidate.getUTCMonth() !== month0) continue;
          if (candidate > after) {
            occurrenceCount++;
            if (count != null && occurrenceCount > count) return null;
            if (until && candidate > until) return null;
            return candidate;
          }
        }
      }
      year += interval;
    }
    return null;
  }

  return null;
}

// ── Timer expression classification ──────────────────────────────────────────

export type TimerKind = 'cycle' | 'date' | 'duration' | 'cron' | 'rrule';

export interface TimerExpression {
  kind: TimerKind;
  raw: string;
}

/**
 * Classify a timer expression string.
 */
export function classifyTimer(expr: string): TimerExpression {
  const s = expr.trim();
  if (s.includes('RRULE:') || s.startsWith('DTSTART:')) return { kind: 'rrule', raw: s };
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

    case 'rrule': {
      const parsed = parseRRule(expr.raw);
      const next = nextRRuleFire(parsed, referenceTime);
      if (!next) throw new Error('RRULE schedule is already exhausted');
      return next;
    }

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

    case 'rrule': {
      const parsed = parseRRule(expr.raw);
      return nextRRuleFire(parsed, firedAt);
    }

    default:
      return null;
  }
}
