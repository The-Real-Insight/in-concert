import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getClient } from '../db/client';
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
  options?: { instanceId?: string }
): Promise<ContinuationDoc | null> {
  const { Continuations } = getCollections(db);
  const now = new Date();
  const filter: Record<string, unknown> = { status: 'READY', dueAt: { $lte: now } };
  if (options?.instanceId) {
    filter.instanceId = options.instanceId;
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
    { sort: { dueAt: 1 } }
  );
  return result;
}

export type ProcessContinuationResult = {
  outbox: Omit<OutboxDoc, '_id'>[];
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

  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      const opts = { session };
      if (result.events.length > 0) {
        await ProcessInstanceEvents.insertMany(
          result.events.map((e) => ({ ...e, _id: uuidv4() })),
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

      for (const ob of result.outbox) {
        await Outbox.insertOne({ ...ob, _id: uuidv4() }, opts);
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
        result.events,
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
    return { outbox: result.outbox, events: result.events };
  } finally {
    await session.endSession();
  }
}
