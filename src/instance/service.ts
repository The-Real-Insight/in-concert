import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { getCollections, type InstanceSynopsisSource } from '../db/collections';
import { getDefinition } from '../model/service';

/** Hard upper bound for synopsis length. Hosts should enforce a tighter
 *  display ceiling in their prompt — this is the absolute backstop so a
 *  runaway LLM can't pollute the column. */
export const INSTANCE_SYNOPSIS_MAX_CHARS = 200;

export type StartInstanceResult = {
  instanceId: string;
  status: string;
  /**
   * True when an existing instance was returned because of an idempotency-key
   * collision. Callers that care about "did I just create a new one?" can
   * branch on this; most callers should treat both cases identically.
   */
  deduplicated?: boolean;
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
  /**
   * Idempotency key for this logical start. Two calls with the same
   * (definitionId, idempotencyKey) pair collapse to a single process
   * instance; the second call returns the existing `instanceId` with
   * `deduplicated: true` and performs no writes. Enforced by a partial
   * unique index on ProcessInstances.
   */
  idempotencyKey?: string;
};

export async function startInstance(
  db: Db,
  params: StartInstanceParams,
): Promise<StartInstanceResult> {
  const def = await getDefinition(db, params.definitionId);
  if (!def) {
    throw new Error('Definition not found');
  }

  // Fast-path: if an idempotency key is set and an instance already exists,
  // return it without opening a transaction.
  if (params.idempotencyKey) {
    const existing = await findByIdempotencyKey(
      db,
      params.definitionId,
      params.idempotencyKey,
      params.session,
    );
    if (existing) {
      return { instanceId: existing._id, status: existing.status, deduplicated: true };
    }
  }

  const instanceId = uuidv4();

  try {
    if (params.session) {
      await writeStartInstance(db, instanceId, params, params.session);
    } else {
      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          await writeStartInstance(db, instanceId, params, session);
        });
      } finally {
        await session.endSession();
      }
    }
    return { instanceId, status: 'RUNNING' };
  } catch (err) {
    // Duplicate-key on (definitionId, idempotencyKey) means a concurrent
    // call won the race. Return the winner's instanceId.
    if (params.idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findByIdempotencyKey(
        db,
        params.definitionId,
        params.idempotencyKey,
        params.session,
      );
      if (existing) {
        return { instanceId: existing._id, status: existing.status, deduplicated: true };
      }
    }
    throw err;
  }
}

async function findByIdempotencyKey(
  db: Db,
  definitionId: string,
  idempotencyKey: string,
  session?: ClientSession,
): Promise<{ _id: string; status: string } | null> {
  const { ProcessInstances } = getCollections(db);
  const doc = await ProcessInstances.findOne(
    { definitionId, idempotencyKey },
    { projection: { _id: 1, status: 1 }, ...(session ? { session } : {}) },
  );
  if (!doc) return null;
  return { _id: doc._id, status: doc.status };
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
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
      ...(params.idempotencyKey != null && { idempotencyKey: params.idempotencyKey }),
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
  tenantId?: string;
  conversationId?: string;
  status: string;
  createdAt: Date;
  endedAt?: Date;
  startedBy?: string;
  startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
  instanceSynopsis?: string;
  instanceSynopsisUpdatedAt?: Date;
  instanceSynopsisSource?: InstanceSynopsisSource;
} | null> {
  const { ProcessInstances } = getCollections(db);
  const doc = await ProcessInstances.findOne(
    { _id: instanceId },
    {
      projection: {
        _id: 1,
        definitionId: 1,
        tenantId: 1,
        conversationId: 1,
        status: 1,
        createdAt: 1,
        endedAt: 1,
        startedBy: 1,
        startedByDetails: 1,
        instanceSynopsis: 1,
        instanceSynopsisUpdatedAt: 1,
        instanceSynopsisSource: 1,
      },
    }
  );
  return doc as {
    _id: string;
    definitionId: string;
    tenantId?: string;
    conversationId?: string;
    status: string;
    createdAt: Date;
    endedAt?: Date;
    startedBy?: string;
    startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
    instanceSynopsis?: string;
    instanceSynopsisUpdatedAt?: Date;
    instanceSynopsisSource?: InstanceSynopsisSource;
  } | null;
}

/**
 * Synopsis record returned by {@link getInstanceSynopsis}. Includes the
 * timestamp so hosts can decide whether to refresh.
 */
export type InstanceSynopsis = {
  text: string;
  updatedAt: Date;
  source: InstanceSynopsisSource;
};

/**
 * Read the short human-readable label for a process instance, or null if
 * none has been set. Hosts compare `updatedAt` against their dirty-check
 * baseline to decide whether the synopsis is stale.
 */
export async function getInstanceSynopsis(
  db: Db,
  instanceId: string
): Promise<InstanceSynopsis | null> {
  const { ProcessInstances } = getCollections(db);
  const doc = await ProcessInstances.findOne(
    { _id: instanceId },
    {
      projection: {
        instanceSynopsis: 1,
        instanceSynopsisUpdatedAt: 1,
        instanceSynopsisSource: 1,
      },
    }
  );
  if (!doc) return null;
  const text = (doc as { instanceSynopsis?: string }).instanceSynopsis;
  const updatedAt = (doc as { instanceSynopsisUpdatedAt?: Date }).instanceSynopsisUpdatedAt;
  const source = (doc as { instanceSynopsisSource?: InstanceSynopsisSource })
    .instanceSynopsisSource;
  if (typeof text !== 'string' || !(updatedAt instanceof Date) || !source) {
    return null;
  }
  return { text, updatedAt, source };
}

/**
 * Write the short human-readable label for a process instance. Policy
 * (when to generate, how to generate, language, length-in-words) lives
 * in the host; the platform only enforces the absolute upper bound
 * `INSTANCE_SYNOPSIS_MAX_CHARS` and rejects empty strings.
 *
 * Returns `true` if the row existed and was updated, `false` if no row
 * matched `instanceId`.
 */
export async function setInstanceSynopsis(
  db: Db,
  instanceId: string,
  text: string,
  options: { source: InstanceSynopsisSource }
): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('setInstanceSynopsis: text must be a non-empty string');
  }
  if (text.length > INSTANCE_SYNOPSIS_MAX_CHARS) {
    throw new Error(
      `setInstanceSynopsis: text exceeds ${INSTANCE_SYNOPSIS_MAX_CHARS}-char ceiling (got ${text.length})`
    );
  }
  const { ProcessInstances } = getCollections(db);
  const result = await ProcessInstances.updateOne(
    { _id: instanceId } as any,
    {
      $set: {
        instanceSynopsis: text,
        instanceSynopsisUpdatedAt: new Date(),
        instanceSynopsisSource: options.source,
      },
    }
  );
  return result.matchedCount > 0;
}

/** One entry returned by {@link completedActivities}. */
export type CompletedActivity = {
  /** Sequence number — monotonic per instance, oldest first. */
  seq: number;
  /** When the activity finished (TASK_COMPLETED.at). */
  completedAt: Date;
  nodeId: string;
  nodeName?: string;
  nodeType?: 'userTask' | 'serviceTask';
  workItemId?: string;
  completedBy?: string;
  /** Activity result payload. Omitted unless `includeData` was true. */
  result?: unknown;
};

/**
 * Ordered list of `TASK_COMPLETED` history entries for an instance — the
 * "what has happened on this case so far" view. Generalized previous-task
 * helper for synopsis generation, audit views, and the eventual
 * "explain this case" surface; do not specialize it for one consumer.
 *
 * `limit` caps the most-recent N entries (default: all). `includeData`
 * controls whether the activity result payload is returned (default: no —
 * it can be large and most consumers only need names + timing).
 */
export async function completedActivities(
  db: Db,
  instanceId: string,
  options?: { limit?: number; includeData?: boolean }
): Promise<CompletedActivity[]> {
  const { ProcessInstanceHistory } = getCollections(db);
  const limit = options?.limit;
  const includeData = options?.includeData === true;

  const projection: Record<string, 1> = {
    seq: 1,
    at: 1,
    nodeId: 1,
    nodeName: 1,
    nodeType: 1,
    workItemId: 1,
    completedBy: 1,
  };
  if (includeData) projection.result = 1;

  let cursor = ProcessInstanceHistory.find(
    { instanceId, eventType: 'TASK_COMPLETED' },
    { projection }
  ).sort({ seq: limit ? -1 : 1 });
  if (limit && limit > 0) cursor = cursor.limit(limit);
  const rows = await cursor.toArray();
  const ordered = limit ? rows.reverse() : rows;
  return ordered.map(r => ({
    seq: r.seq,
    completedAt: (r as { at: Date }).at,
    nodeId: (r as { nodeId?: string }).nodeId ?? '',
    nodeName: (r as { nodeName?: string }).nodeName,
    nodeType: (r as { nodeType?: 'userTask' | 'serviceTask' }).nodeType,
    workItemId: (r as { workItemId?: string }).workItemId,
    completedBy: (r as { completedBy?: string }).completedBy,
    ...(includeData ? { result: (r as { result?: unknown }).result } : {}),
  }));
}
