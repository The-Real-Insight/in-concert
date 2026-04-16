import {
  parseDuration,
  addDuration,
  parseRepeat,
  parseCron,
  nextCronFire,
  parseRRule,
  nextRRuleFire,
  classifyTimer,
  computeNextFire,
  computeNextFireAfter,
} from './expressions';

describe('parseDuration', () => {
  it('parses PT30M', () => {
    const d = parseDuration('PT30M');
    expect(d).toEqual({ years: 0, months: 0, days: 0, hours: 0, minutes: 30, seconds: 0 });
  });

  it('parses P1DT2H30M', () => {
    const d = parseDuration('P1DT2H30M');
    expect(d).toEqual({ years: 0, months: 0, days: 1, hours: 2, minutes: 30, seconds: 0 });
  });

  it('parses PT10S', () => {
    const d = parseDuration('PT10S');
    expect(d).toEqual({ years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 10 });
  });

  it('parses P1Y2M3D', () => {
    const d = parseDuration('P1Y2M3D');
    expect(d).toEqual({ years: 1, months: 2, days: 3, hours: 0, minutes: 0, seconds: 0 });
  });

  it('rejects invalid input', () => {
    expect(() => parseDuration('invalid')).toThrow('Invalid ISO 8601 duration');
  });
});

describe('addDuration', () => {
  it('adds 1 hour', () => {
    const base = new Date('2026-04-16T10:00:00Z');
    const result = addDuration(base, parseDuration('PT1H'));
    expect(result.toISOString()).toBe('2026-04-16T11:00:00.000Z');
  });

  it('adds 1 day and 30 minutes', () => {
    const base = new Date('2026-04-16T10:00:00Z');
    const result = addDuration(base, parseDuration('P1DT30M'));
    expect(result.toISOString()).toBe('2026-04-17T10:30:00.000Z');
  });
});

describe('parseRepeat', () => {
  it('parses unbounded R/PT1H', () => {
    const r = parseRepeat('R/PT1H');
    expect(r.repetitions).toBeNull();
    expect(r.duration.hours).toBe(1);
  });

  it('parses bounded R3/PT10M', () => {
    const r = parseRepeat('R3/PT10M');
    expect(r.repetitions).toBe(3);
    expect(r.duration.minutes).toBe(10);
  });

  it('rejects invalid input', () => {
    expect(() => parseRepeat('PT1H')).toThrow('Invalid ISO 8601 repeating interval');
  });
});

describe('parseCron', () => {
  it('parses every-hour cron', () => {
    const c = parseCron('0 * * * *');
    expect(c.minute.values).toEqual([0]);
    expect(c.hour.values).toBeNull();
    expect(c.dayOfMonth.values).toBeNull();
  });

  it('parses weekday mornings', () => {
    const c = parseCron('30 8 * * 1-5');
    expect(c.minute.values).toEqual([30]);
    expect(c.hour.values).toEqual([8]);
    expect(c.dayOfWeek.values).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses step syntax', () => {
    const c = parseCron('*/15 * * * *');
    expect(c.minute.values).toEqual([0, 15, 30, 45]);
  });

  it('rejects wrong field count', () => {
    expect(() => parseCron('0 * *')).toThrow('Invalid cron expression');
  });
});

describe('nextCronFire', () => {
  it('finds next hourly fire', () => {
    const cron = parseCron('0 * * * *');
    const after = new Date('2026-04-16T10:30:00Z');
    const next = nextCronFire(cron, after);
    expect(next.toISOString()).toBe('2026-04-16T11:00:00.000Z');
  });

  it('finds next weekday morning', () => {
    const cron = parseCron('30 8 * * 1-5');
    // 2026-04-16 is a Thursday
    const after = new Date('2026-04-16T08:30:00Z');
    const next = nextCronFire(cron, after);
    // Next match: Friday 2026-04-17 at 08:30
    expect(next.toISOString()).toBe('2026-04-17T08:30:00.000Z');
  });
});

describe('classifyTimer', () => {
  it('classifies ISO cycle', () => {
    expect(classifyTimer('R/PT1H').kind).toBe('cycle');
  });

  it('classifies ISO duration', () => {
    expect(classifyTimer('PT30M').kind).toBe('duration');
  });

  it('classifies ISO date', () => {
    expect(classifyTimer('2026-04-16T09:00:00Z').kind).toBe('date');
  });

  it('classifies cron', () => {
    expect(classifyTimer('0 * * * *').kind).toBe('cron');
  });
});

describe('computeNextFire', () => {
  const ref = new Date('2026-04-16T10:00:00Z');

  it('date: returns the date itself', () => {
    const expr = classifyTimer('2026-12-25T00:00:00Z');
    const next = computeNextFire(expr, ref);
    expect(next.toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });

  it('duration: adds to reference', () => {
    const expr = classifyTimer('PT2H');
    const next = computeNextFire(expr, ref);
    expect(next.toISOString()).toBe('2026-04-16T12:00:00.000Z');
  });

  it('cycle: first fire = reference + duration', () => {
    const expr = classifyTimer('R/PT1H');
    const next = computeNextFire(expr, ref);
    expect(next.toISOString()).toBe('2026-04-16T11:00:00.000Z');
  });

  it('cron: first fire after reference', () => {
    const expr = classifyTimer('0 12 * * *');
    const next = computeNextFire(expr, ref);
    expect(next.toISOString()).toBe('2026-04-16T12:00:00.000Z');
  });
});

describe('computeNextFireAfter', () => {
  it('date: returns null (one-shot)', () => {
    const expr = classifyTimer('2026-12-25T00:00:00Z');
    expect(computeNextFireAfter(expr, new Date(), null)).toBeNull();
  });

  it('duration: returns null (one-shot)', () => {
    const expr = classifyTimer('PT30M');
    expect(computeNextFireAfter(expr, new Date(), null)).toBeNull();
  });

  it('unbounded cycle: returns next fire', () => {
    const expr = classifyTimer('R/PT1H');
    const fired = new Date('2026-04-16T11:00:00Z');
    const next = computeNextFireAfter(expr, fired, null);
    expect(next!.toISOString()).toBe('2026-04-16T12:00:00.000Z');
  });

  it('bounded cycle: decrements and returns next', () => {
    const expr = classifyTimer('R3/PT10M');
    const fired = new Date('2026-04-16T10:10:00Z');
    const next = computeNextFireAfter(expr, fired, 2);
    expect(next!.toISOString()).toBe('2026-04-16T10:20:00.000Z');
  });

  it('bounded cycle: exhausted when remaining <= 0', () => {
    const expr = classifyTimer('R3/PT10M');
    expect(computeNextFireAfter(expr, new Date(), 0)).toBeNull();
  });

  it('cron: returns next cron fire', () => {
    const expr = classifyTimer('0 * * * *');
    const fired = new Date('2026-04-16T10:00:00Z');
    const next = computeNextFireAfter(expr, fired, null);
    expect(next!.toISOString()).toBe('2026-04-16T11:00:00.000Z');
  });

  it('rrule: returns next fire', () => {
    const expr = classifyTimer('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1');
    const fired = new Date('2026-04-16T09:00:00Z');
    const next = computeNextFireAfter(expr, fired, null);
    expect(next!.toISOString()).toBe('2026-04-17T09:00:00.000Z');
  });
});

// ── RRULE ────────────────────────────────────────────────────────────────────

describe('parseRRule', () => {
  it('parses basic daily rule', () => {
    const r = parseRRule('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;INTERVAL=3');
    expect(r.freq).toBe('DAILY');
    expect(r.interval).toBe(3);
    expect(r.dtstart.toISOString()).toBe('2026-04-16T09:00:00.000Z');
  });

  it('parses weekly with BYDAY', () => {
    const r = parseRRule('DTSTART:20260413T083000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR');
    expect(r.freq).toBe('WEEKLY');
    expect(r.interval).toBe(2);
    expect(r.byDay).toEqual(['MO', 'WE', 'FR']);
  });

  it('parses monthly with BYSETPOS', () => {
    const r = parseRRule('DTSTART:20260424T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
    expect(r.freq).toBe('MONTHLY');
    expect(r.byDay).toEqual(['FR']);
    expect(r.bySetPos).toEqual([-1]);
  });

  it('accepts semicolon separator between DTSTART and RRULE', () => {
    const r = parseRRule('DTSTART:20260416T090000Z;RRULE:FREQ=DAILY;INTERVAL=1');
    expect(r.freq).toBe('DAILY');
  });

  it('parses COUNT', () => {
    const r = parseRRule('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;COUNT=5');
    expect(r.count).toBe(5);
  });

  it('parses UNTIL', () => {
    const r = parseRRule('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;UNTIL=20261231T235959Z');
    expect(r.until!.toISOString()).toBe('2026-12-31T23:59:59.000Z');
  });
});

describe('nextRRuleFire', () => {
  it('DAILY every 3 days', () => {
    const r = parseRRule('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;INTERVAL=3');
    const after = new Date('2026-04-16T09:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next!.toISOString()).toBe('2026-04-19T09:00:00.000Z');
  });

  it('DAILY every 1 day, first fire is dtstart if after < dtstart', () => {
    const r = parseRRule('DTSTART:20260420T100000Z\nRRULE:FREQ=DAILY;INTERVAL=1');
    const after = new Date('2026-04-16T09:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next!.toISOString()).toBe('2026-04-20T10:00:00.000Z');
  });

  it('WEEKLY every 2 weeks on MO,WE,FR', () => {
    const r = parseRRule('DTSTART:20260413T083000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR');
    // 2026-04-13 is a Monday. After that Monday at 08:30:
    const after = new Date('2026-04-13T08:30:00Z');
    const next = nextRRuleFire(r, after);
    // Next in same week: Wednesday 2026-04-15
    expect(next!.toISOString()).toBe('2026-04-15T08:30:00.000Z');
  });

  it('WEEKLY skips to next interval week', () => {
    const r = parseRRule('DTSTART:20260413T090000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    // After the first Monday (2026-04-13), next should be 2 weeks later
    const after = new Date('2026-04-13T09:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next!.toISOString()).toBe('2026-04-27T09:00:00.000Z');
  });

  it('MONTHLY on the 15th', () => {
    const r = parseRRule('DTSTART:20260115T100000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15');
    const after = new Date('2026-04-16T00:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next!.toISOString()).toBe('2026-05-15T10:00:00.000Z');
  });

  it('MONTHLY last Friday (BYSETPOS=-1)', () => {
    const r = parseRRule('DTSTART:20260130T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
    const after = new Date('2026-04-01T00:00:00Z');
    const next = nextRRuleFire(r, after);
    // Last Friday of April 2026 = April 24
    expect(next!.toISOString()).toBe('2026-04-24T09:00:00.000Z');
  });

  it('MONTHLY second Tuesday (BYSETPOS=2)', () => {
    const r = parseRRule('DTSTART:20260113T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2');
    const after = new Date('2026-04-14T09:00:00Z');
    const next = nextRRuleFire(r, after);
    // Second Tuesday of May 2026 = May 12
    expect(next!.toISOString()).toBe('2026-05-12T09:00:00.000Z');
  });

  it('MONTHLY first weekday (MO-FR, BYSETPOS=1)', () => {
    const r = parseRRule('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1');
    const after = new Date('2026-04-30T00:00:00Z');
    const next = nextRRuleFire(r, after);
    // First weekday of May 2026 = May 1 (Friday)
    expect(next!.toISOString()).toBe('2026-05-01T09:00:00.000Z');
  });

  it('MONTHLY on 31st skips short months', () => {
    const r = parseRRule('DTSTART:20260131T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31');
    const after = new Date('2026-01-31T09:00:00Z');
    const next = nextRRuleFire(r, after);
    // Feb has no 31st, March has 31st
    expect(next!.toISOString()).toBe('2026-03-31T09:00:00.000Z');
  });

  it('YEARLY on March 15', () => {
    const r = parseRRule('DTSTART:20260315T090000Z\nRRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15');
    const after = new Date('2026-03-15T09:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next!.toISOString()).toBe('2027-03-15T09:00:00.000Z');
  });

  it('YEARLY second Tuesday of November', () => {
    const r = parseRRule('DTSTART:20261110T090000Z\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=TU;BYSETPOS=2');
    const after = new Date('2026-01-01T00:00:00Z');
    const next = nextRRuleFire(r, after);
    // Second Tuesday of November 2026 = Nov 10
    expect(next!.toISOString()).toBe('2026-11-10T09:00:00.000Z');
  });

  it('COUNT exhaustion', () => {
    const r = parseRRule('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1;COUNT=3');
    // After the 3rd occurrence (Apr 18), should be null
    const after = new Date('2026-04-18T09:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next).toBeNull();
  });

  it('UNTIL exhaustion', () => {
    const r = parseRRule('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20260418T235959Z');
    const after = new Date('2026-04-18T09:00:00Z');
    const next = nextRRuleFire(r, after);
    expect(next).toBeNull();
  });
});

describe('classifyTimer - rrule', () => {
  it('classifies RRULE expression', () => {
    expect(classifyTimer('DTSTART:20260416T090000Z\nRRULE:FREQ=DAILY').kind).toBe('rrule');
  });

  it('classifies inline RRULE expression', () => {
    expect(classifyTimer('DTSTART:20260416T090000Z;RRULE:FREQ=WEEKLY;BYDAY=MO').kind).toBe('rrule');
  });
});
