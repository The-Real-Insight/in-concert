import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import { getDefinition } from '../model/service';

export type StartInstanceResult = {
  instanceId: string;
  status: string;
};

export async function startInstance(
  db: Db,
  params: {
    commandId: string;
    definitionId: string;
    businessKey?: string;
    tenantId?: string;
    user?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
  }
): Promise<StartInstanceResult> {
  const cols = getCollections(db);
  const { ProcessDefinitions, ProcessInstances, ProcessInstanceState, Continuations } = cols;

  const def = await getDefinition(db, params.definitionId);
  if (!def) {
    throw new Error('Definition not found');
  }

  const instanceId = uuidv4();
  const now = new Date();

  await ProcessInstances.insertOne({
    _id: instanceId,
    definitionId: params.definitionId,
    tenantId: params.tenantId,
    rootInstanceId: instanceId,
    status: 'RUNNING',
    createdAt: now,
    businessKey: params.businessKey,
    ...(params.user != null && {
      startedBy: params.user.email,
      startedByDetails: params.user,
    }),
  });

  await ProcessInstanceState.insertOne({
    _id: instanceId,
    version: 0,
    status: 'RUNNING',
    tokens: [],
    scopes: [],
    waits: {
      workItems: [],
      messageSubs: [],
      timers: [],
      decisions: [],
    },
    dedupe: {
      processedCommandIds: [],
      completedWorkItemIds: [],
      processedMessageIds: [],
      recordedDecisionIds: [],
    },
    lastEventSeq: 0,
    updatedAt: now,
  });

  await Continuations.insertOne({
    _id: uuidv4(),
    instanceId,
    dueAt: now,
    kind: 'START',
    payload: { commandId: params.commandId },
    status: 'READY',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });

  return { instanceId, status: 'RUNNING' };
}

export async function getInstance(
  db: Db,
  instanceId: string
): Promise<{
  _id: string;
  status: string;
  createdAt: Date;
  endedAt?: Date;
  startedBy?: string;
  startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
} | null> {
  const { ProcessInstances } = getCollections(db);
  const doc = await ProcessInstances.findOne(
    { _id: instanceId },
    { projection: { _id: 1, status: 1, createdAt: 1, endedAt: 1, startedBy: 1, startedByDetails: 1 } }
  );
  return doc as {
    _id: string;
    status: string;
    createdAt: Date;
    endedAt?: Date;
    startedBy?: string;
    startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
  } | null;
}
