import {
  parseDuration,
  addDuration,
  parseRepeat,
  parseCron,
  nextCronFire,
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
});
