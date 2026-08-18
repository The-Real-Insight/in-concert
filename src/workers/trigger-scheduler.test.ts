/**
 * Retry backoff after a failed fire.
 *
 * The bug this locks in: a failing schedule used to be re-claimed on the very next worker tick,
 * because `lastFiredAt` (the anchor the interval form is measured from) is only advanced on
 * success, so `now - lastFiredAt >= intervalMs` stayed true forever and the lease was released
 * immediately. Measured on production: an RSS schedule configured at `intervalMs: 60_000` fired
 * 1,182,831 times in 24 h — ~14/s, ~820x its own interval — every one the same failed fetch.
 */
import { computeRetryDelayMs } from './trigger-scheduler';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe('computeRetryDelayMs', () => {
  it('doubles with each consecutive failure', () => {
    expect(computeRetryDelayMs(1)).toBe(30 * SECOND);
    expect(computeRetryDelayMs(2)).toBe(60 * SECOND);
    expect(computeRetryDelayMs(3)).toBe(2 * MINUTE);
    expect(computeRetryDelayMs(4)).toBe(4 * MINUTE);
  });

  it('caps the delay at 30 minutes', () => {
    expect(computeRetryDelayMs(10)).toBe(30 * MINUTE);
    expect(computeRetryDelayMs(100)).toBe(30 * MINUTE);
    // The exponent is clamped, so an absurd counter must not overflow to Infinity or NaN.
    expect(Number.isFinite(computeRetryDelayMs(5000))).toBe(true);
    expect(computeRetryDelayMs(5000)).toBe(30 * MINUTE);
  });

  it('never retries sooner than the schedule’s own interval', () => {
    // Backing off may only ever slow a schedule down. A 10-minute interval must not be
    // retried after the 30 s base delay just because it failed once.
    expect(computeRetryDelayMs(1, 10 * MINUTE)).toBe(10 * MINUTE);
    expect(computeRetryDelayMs(2, 10 * MINUTE)).toBe(10 * MINUTE);
    // ...but once the exponential passes the interval, the exponential wins.
    expect(computeRetryDelayMs(6, 10 * MINUTE)).toBe(16 * MINUTE);
  });

  it('still honours the cap when the interval is longer than it', () => {
    // A schedule polling once a day must not be pinned to the 30-minute cap: the interval is
    // the floor, so the effective wait is the interval itself.
    expect(computeRetryDelayMs(1, 24 * 60 * MINUTE)).toBe(24 * 60 * MINUTE);
  });

  it('treats a missing or zero failure count as the first attempt', () => {
    expect(computeRetryDelayMs(0)).toBe(30 * SECOND);
    expect(computeRetryDelayMs(-3)).toBe(30 * SECOND);
  });

  it('reproduces the production case: 60 s interval, first failure waits a minute, not 70 ms', () => {
    const intervalMs = 60_000;
    expect(computeRetryDelayMs(1, intervalMs)).toBe(60 * SECOND);
    // Ten consecutive failures reach the cap: 24 retries/day instead of 1,182,831.
    expect(computeRetryDelayMs(10, intervalMs)).toBe(30 * MINUTE);
  });
});
