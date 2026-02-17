import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getClient } from '../db/client';
import { getCollections } from '../db/collections';
import { getDefinition } from '../model/service';
import { applyTransition } from '../engine/transition';
import type { ProcessInstanceStateDoc, ContinuationDoc } from '../db/collections';

const LEASE_MS = 30_000;

export async function claimContinuation(db: Db): Promise<ContinuationDoc | null> {
  const { Continuations } = getCollections(db);
  const now = new Date();
  const result = await Continuations.findOneAndUpdate(
    { status: 'READY', dueAt: { $lte: now } },
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

export async function processContinuation(db: Db, continuation: ContinuationDoc): Promise<void> {
  const cols = getCollections(db);
  const { ProcessInstanceState, ProcessInstanceEvents, Continuations, Outbox } = cols;

  const stateDoc = await ProcessInstanceState.findOne({ _id: continuation.instanceId });
  if (!stateDoc) return;

  const { ProcessInstances } = cols;
  const instanceDoc = await ProcessInstances.findOne(
    { _id: continuation.instanceId },
    { projection: { definitionId: 1 } }
  );
  const definitionId = instanceDoc?.definitionId as string | undefined;
  if (!definitionId) return;
  const def = await getDefinition(db, definitionId);
  if (!def) return;

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
    return;
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

      await Continuations.updateOne(
        { _id: continuation._id },
        { $set: { status: 'DONE', updatedAt: now } },
        opts
      );
    });
  } finally {
    await session.endSession();
  }
}
