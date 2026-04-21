import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { getCollections } from '../db/collections';
import { getDefinition } from '../model/service';

export type StartInstanceResult = {
  instanceId: string;
  status: string;
};

export type StartInstanceParams = {
  commandId: string;
  definitionId: string;
  conversationId?: string;
  businessKey?: string;
  tenantId?: string;
  user?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
  /**
   * When true, skip inserting the START Continuation. The instance is created in RUNNING state
   * but will not advance until the caller explicitly calls {@link insertStartContinuation}.
   * Intended for entry points (e.g. graph-mailbox) that must finish async setup (attachments,
   * RAG, data-pool seeding) before the BPMN engine sees the first token.
   */
  deferContinuation?: boolean;
  /**
   * Optional Mongo session. When provided, all writes participate in the
   * caller's transaction; the caller owns commit/abort. When absent,
   * `startInstance` opens its own short-lived transaction so the three
   * writes (`ProcessInstances`, `ProcessInstanceState`, `Continuations`)
   * either all succeed or all roll back — a crash mid-call never leaves
   * orphaned rows.
   */
  session?: ClientSession;
};

export async function startInstance(
  db: Db,
  params: StartInstanceParams,
): Promise<StartInstanceResult> {
  const def = await getDefinition(db, params.definitionId);
  if (!def) {
    throw new Error('Definition not found');
  }

  const instanceId = uuidv4();

  if (params.session) {
    await writeStartInstance(db, instanceId, params, params.session);
    return { instanceId, status: 'RUNNING' };
  }

  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      await writeStartInstance(db, instanceId, params, session);
    });
  } finally {
    await session.endSession();
  }
  return { instanceId, status: 'RUNNING' };
}

async function writeStartInstance(
  db: Db,
  instanceId: string,
  params: StartInstanceParams,
  session: ClientSession,
): Promise<void> {
  const { ProcessInstances, ProcessInstanceState, Continuations } = getCollections(db);
  const now = new Date();
  const opts = { session };

  await ProcessInstances.insertOne(
    {
      _id: instanceId,
      definitionId: params.definitionId,
      conversationId: params.conversationId,
      tenantId: params.tenantId,
      rootInstanceId: instanceId,
      status: 'RUNNING',
      createdAt: now,
      businessKey: params.businessKey,
      ...(params.user != null && {
        startedBy: params.user.email,
        startedByDetails: params.user,
      }),
    },
    opts,
  );

  await ProcessInstanceState.insertOne(
    {
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
    },
    opts,
  );

  if (!params.deferContinuation) {
    await Continuations.insertOne(
      {
        _id: uuidv4(),
        instanceId,
        dueAt: now,
        kind: 'START',
        payload: { commandId: params.commandId },
        status: 'READY',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
      opts,
    );
  }
}

/**
 * Insert the START Continuation for an instance that was created with `deferContinuation: true`.
 * After this resolves the BPMN engine may pick it up and begin advancing tokens.
 */
export async function insertStartContinuation(
  db: Db,
  params: { instanceId: string; commandId: string; session?: ClientSession }
): Promise<void> {
  const { Continuations } = getCollections(db);
  const now = new Date();
  const opts = params.session ? { session: params.session } : undefined;
  await Continuations.insertOne(
    {
      _id: uuidv4(),
      instanceId: params.instanceId,
      dueAt: now,
      kind: 'START',
      payload: { commandId: params.commandId },
      status: 'READY',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    },
    opts,
  );
}

/**
 * Purge a process instance and the full transitive closure of its descendants
 * (child instances created by call activities, grandchildren, etc.) from the
 * database. Removes all per-instance rows across ProcessInstance,
 * ProcessInstanceState, ProcessInstanceEvent, ProcessInstanceHistory,
 * Continuation, Outbox, and HumanTask.
 *
 * Returns null if the instance does not exist, otherwise the list of purged
 * instance ids (the root first, then descendants).
 */
export async function purgeInstance(
  db: Db,
  instanceId: string
): Promise<{ purgedInstanceIds: string[] } | null> {
  const {
    ProcessInstances,
    ProcessInstanceState,
    ProcessInstanceEvents,
    ProcessInstanceHistory,
    Continuations,
    Outbox,
    HumanTasks,
  } = getCollections(db);

  const root = await ProcessInstances.findOne({ _id: instanceId }, { projection: { _id: 1 } });
  if (!root) return null;

  const allIds: string[] = [instanceId];
  let frontier: string[] = [instanceId];
  while (frontier.length > 0) {
    const children = await ProcessInstances
      .find({ parentInstanceId: { $in: frontier } }, { projection: { _id: 1 } })
      .toArray();
    const childIds = children.map((c) => c._id);
    if (childIds.length === 0) break;
    allIds.push(...childIds);
    frontier = childIds;
  }

  const idFilter = { _id: { $in: allIds } };
  const fkFilter = { instanceId: { $in: allIds } };
  await Promise.all([
    ProcessInstances.deleteMany(idFilter),
    ProcessInstanceState.deleteMany(idFilter),
    ProcessInstanceEvents.deleteMany(fkFilter),
    ProcessInstanceHistory.deleteMany(fkFilter),
    Continuations.deleteMany(fkFilter),
    Outbox.deleteMany(fkFilter),
    HumanTasks.deleteMany(fkFilter),
  ]);

  return { purgedInstanceIds: allIds };
}

export async function getInstance(
  db: Db,
  instanceId: string
): Promise<{
  _id: string;
  definitionId: string;
  conversationId?: string;
  status: string;
  createdAt: Date;
  endedAt?: Date;
  startedBy?: string;
  startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
} | null> {
  const { ProcessInstances } = getCollections(db);
  const doc = await ProcessInstances.findOne(
    { _id: instanceId },
    { projection: { _id: 1, definitionId: 1, conversationId: 1, status: 1, createdAt: 1, endedAt: 1, startedBy: 1, startedByDetails: 1 } }
  );
  return doc as {
    _id: string;
    definitionId: string;
    conversationId?: string;
    status: string;
    createdAt: Date;
    endedAt?: Date;
    startedBy?: string;
    startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
  } | null;
}
