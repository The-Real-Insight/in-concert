/**
 * Lease sweeper: reclaims work units that were claimed by a worker but whose
 * lease expired without the worker finishing. Without this, a server crash
 * between `claimContinuation` (which sets status=IN_PROGRESS) and the
 * transaction that would have set status=DONE leaves the continuation stuck
 * forever — `claimContinuation` only picks up status=READY rows.
 *
 * Runs once on startup and then periodically. Safe to run concurrently with
 * workers: only rows whose leaseUntil is in the past are touched.
 */
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';

export type SweepResult = {
  continuations: number;
  timers: number;
  connectors: number;
};

export async function sweepExpiredLeases(db: Db): Promise<SweepResult> {
  const { Continuations, TimerSchedules, ConnectorSchedules } = getCollections(db);
  const now = new Date();

  const contRes = await Continuations.updateMany(
    { status: 'IN_PROGRESS', leaseUntil: { $lt: now } },
    { $set: { status: 'READY', updatedAt: now }, $unset: { ownerId: '', leaseUntil: '' } },
  );

  const timerRes = await TimerSchedules.updateMany(
    { leaseUntil: { $lt: now } },
    { $set: { updatedAt: now }, $unset: { ownerId: '', leaseUntil: '' } },
  );

  const connRes = await ConnectorSchedules.updateMany(
    { leaseUntil: { $lt: now } },
    { $set: { updatedAt: now }, $unset: { ownerId: '', leaseUntil: '' } },
  );

  return {
    continuations: contRes.modifiedCount ?? 0,
    timers: timerRes.modifiedCount ?? 0,
    connectors: connRes.modifiedCount ?? 0,
  };
}
