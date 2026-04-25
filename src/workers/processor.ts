import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import { getDefinition } from '../model/service';
import { applyTransition } from '../engine/transition';
import { buildHistoryRecords } from '../history/service';
import type {
  ProcessInstanceStateDoc,
  ContinuationDoc,
  OutboxDoc,
} from '../db/collections';

const LEASE_MS = 30_000;

export async function claimContinuation(
  db: Db,
  options?: { instanceId?: string; excludeInstanceIds?: string[] }
): Promise<ContinuationDoc | null> {
  const { Continuations } = getCollections(db);
  const now = new Date();
  const filter: Record<string, unknown> = { status: 'READY', dueAt: { $lte: now } };
  if (options?.instanceId) {
    filter.instanceId = options.instanceId;
  } else if (options?.excludeInstanceIds && options.excludeInstanceIds.length > 0) {
    filter.instanceId = { $nin: options.excludeInstanceIds };
  }
  const result = await Continuations.findOneAndUpdate(
    filter,
    {
      $set: {
        status: 'IN_PROGRESS',
        ownerId: uuidv4(),
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { dueAt: 1 }, readConcern: { level: 'majority' } }
  );
  return result;
}

export type ProcessContinuationResult = {
  outbox: OutboxDoc[];
  events: import('../db/collections').ProcessInstanceEventDoc[];
};

export async function processContinuation(
  db: Db,
  continuation: ContinuationDoc
): Promise<ProcessContinuationResult> {
  const cols = getCollections(db);
  const { ProcessInstanceState, ProcessInstanceEvents, Continuations, Outbox, ProcessInstanceHistory } = cols;

  const stateDoc = await ProcessInstanceState.findOne({ _id: continuation.instanceId });
  if (!stateDoc) return { outbox: [], events: [] };

  const { ProcessInstances } = cols;
  const instanceDoc = await ProcessInstances.findOne(
    { _id: continuation.instanceId },
    { projection: { definitionId: 1, startedBy: 1, startedByDetails: 1 } }
  );
  const definitionId = instanceDoc?.definitionId as string | undefined;
  if (!definitionId) return { outbox: [], events: [] };
  const def = await getDefinition(db, definitionId);
  if (!def) return { outbox: [], events: [] };

  const result = applyTransition(
    stateDoc as ProcessInstanceStateDoc,
    continuation,
    def.graph,
    new Date()
  );

  if (result.events.length === 0 && Object.keys(result.statePatch).length === 0) {
    await Continuations.updateOne(
      { _id: continuation._id },
      { $set: { status: 'DONE', updatedAt: new Date() } }
    );
    return { outbox: [], events: [] };
  }

  const now = new Date();

  let outboxWithIds: OutboxDoc[] = [];
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const opts = { session };
      const numEvents = result.events.length;

      // Atomically reserve seq numbers first to avoid E11000 duplicate key races
      // when multiple workers or retries process the same instance.
      let eventsToInsert = result.events;
      if (numEvents > 0) {
        const updateResult = await ProcessInstanceState.findOneAndUpdate(
          { _id: continuation.instanceId, version: stateDoc.version },
          { $inc: { lastEventSeq: numEvents } },
          { ...opts, returnDocument: 'after' }
        );
        if (!updateResult) {
          throw new Error('Version conflict');
        }
        const startSeq = (updateResult.lastEventSeq ?? stateDoc.lastEventSeq) - numEvents + 1;
        eventsToInsert = result.events.map((e, i) => ({ ...e, seq: startSeq + i }));
      }

      if (numEvents > 0) {
        await ProcessInstanceEvents.insertMany(
          eventsToInsert.map((e) => ({ ...e, _id: uuidv4() })),
          opts
        );
      }

      if (Object.keys(result.statePatch).length > 0) {
        const setOp = { ...result.statePatch, updatedAt: now };
        const updateResult = await ProcessInstanceState.updateOne(
          { _id: continuation.instanceId, version: stateDoc.version },
          { $set: setOp },
          opts
        );
        if (updateResult.matchedCount === 0) {
          throw new Error('Version conflict');
        }
        if (result.statePatch.status === 'COMPLETED') {
          await ProcessInstances.updateOne(
            { _id: continuation.instanceId },
            { $set: { status: 'COMPLETED', endedAt: now, updatedAt: now } },
            opts
          );
        }
      }

      for (const nc of result.newContinuations) {
        await Continuations.insertOne(
          { ...nc, _id: uuidv4() } as ContinuationDoc,
          opts
        );
      }

      outboxWithIds = result.outbox.map((ob) => ({ ...ob, _id: uuidv4() }));
      for (const ob of outboxWithIds) {
        await Outbox.insertOne(ob, opts);
      }

      const continuationPayload =
        continuation.kind === 'WORK_COMPLETED'
          ? (continuation.payload as {
              completedBy?: string;
              completedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
              result?: unknown;
            })
          : null;
      const historyRecords = buildHistoryRecords(
        continuation.instanceId,
        eventsToInsert,
        instanceDoc,
        continuationPayload,
        def.graph
      );
      for (const rec of historyRecords) {
        await ProcessInstanceHistory.insertOne(
          { ...rec, _id: uuidv4() },
          opts
        );
      }

      await Continuations.updateOne(
        { _id: continuation._id },
        { $set: { status: 'DONE', updatedAt: now } },
        opts
      );
    });
    return { outbox: outboxWithIds, events: result.events };
  } finally {
    await session.endSession();
  }
}
