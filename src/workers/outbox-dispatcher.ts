/**
 * Outbox dispatcher: re-broadcasts Outbox rows that were written to the
 * database but never dispatched in-process (e.g. because the server crashed
 * between transaction commit and the inline broadcast).
 *
 * The hot path still broadcasts inline from the continuation worker for low
 * latency; after that inline broadcast succeeds the caller should invoke
 * {@link markOutboxSent} with the just-broadcast `_id`s so the dispatcher
 * does not re-send them. The dispatcher then only picks up stragglers —
 * rows still in `READY` status after `stalenessMs`.
 */
import type { Db } from 'mongodb';
import { getCollections, type OutboxDoc } from '../db/collections';
import { broadcastOutbox } from '../ws/broadcast';

const DEFAULT_STALENESS_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;

export async function markOutboxSent(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { Outbox } = getCollections(db);
  await Outbox.updateMany(
    { _id: { $in: ids }, status: 'READY' },
    { $set: { status: 'SENT', updatedAt: new Date() } },
  );
}

export async function dispatchOutboxBatch(
  db: Db,
  options?: { stalenessMs?: number; batchSize?: number },
): Promise<number> {
  const stalenessMs = options?.stalenessMs ?? DEFAULT_STALENESS_MS;
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const { Outbox } = getCollections(db);
  const cutoff = new Date(Date.now() - stalenessMs);

  const stragglers = (await Outbox.find(
    { status: 'READY', createdAt: { $lte: cutoff } },
    { sort: { createdAt: 1 }, limit: batchSize },
  ).toArray()) as OutboxDoc[];

  if (stragglers.length === 0) return 0;

  broadcastOutbox(stragglers);
  await markOutboxSent(db, stragglers.map((s) => s._id));
  return stragglers.length;
}
