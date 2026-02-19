import { Db } from 'mongodb';
import { COLLECTION_NAMES } from './collections';

export async function ensureIndexes(db: Db): Promise<void> {
  await db
    .collection(COLLECTION_NAMES.ProcessInstanceEvents)
    .createIndex({ instanceId: 1, seq: 1 }, { unique: true });

  await db
    .collection(COLLECTION_NAMES.Continuations)
    .createIndex({ status: 1, dueAt: 1 });

  await db
    .collection(COLLECTION_NAMES.Continuations)
    .createIndex({ instanceId: 1 });

  await db
    .collection(COLLECTION_NAMES.Outbox)
    .createIndex({ status: 1, nextAttemptAt: 1 });

  await db
    .collection(COLLECTION_NAMES.ProcessDefinitions)
    .createIndex({ name: 1, version: 1 }, { unique: true });

  await db
    .collection(COLLECTION_NAMES.HumanTasks)
    .createIndex({ status: 1, assigneeUserId: 1, createdAt: -1 });

  await db
    .collection(COLLECTION_NAMES.HumanTasks)
    .createIndex({ status: 1, candidateRoles: 1, createdAt: -1 });

  await db
    .collection(COLLECTION_NAMES.HumanTasks)
    .createIndex({ instanceId: 1 });

  await db
    .collection(COLLECTION_NAMES.ProcessInstanceHistory)
    .createIndex({ instanceId: 1, seq: 1 });
}
