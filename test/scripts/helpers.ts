import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Db } from 'mongodb';
import { connectDb, closeDb, getDb } from '../../src/db/client';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { deployDefinition } from '../../src/model/service';
import { startInstance } from '../../src/instance/service';

const callbackLog = jest.fn();

export const mockCallbacks = {
  log: callbackLog,
  reset: () => callbackLog.mockClear(),
};

/** Mock user for tests (process start, user task completion). */
export const MOCK_USER = {
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  phone: '+1234567890',
  photoUrl: 'https://example.com/photo.jpg',
} as const;

/** Map TEST.md model names to actual BPMN filenames in test/bpmn/ */
export const BPMN_FILES: Record<string, string> = {
  'linear.bpmn': 'start-service-task-end.bpmn',
  'start-user-task-end.bpmn': 'start-user-task-end.bpmn',
  'start-service-task-end.bpmn': 'start-service-task-end.bpmn',
  'xor-split-with-default.bpmn': 'xor-split-with-default.bpmn',
  'and-split-join.bpmn': 'and-split-join.bpmn',
  'or-split-join.bpmn': 'or-split-join.bpmn',
  'intermediate-timer.bpmn': 'intermediate-catch-timer.bpmn',
  'boundary-timer-interrupting.bpmn': 'interrupting-boundary-timer-on-task.bpmn',
  'boundary-error-on-task.bpmn': 'boundary-error-on-taks.bpmn',
  'message-catch.bpmn': 'message-catch-then-continue.bpmn',
  'message-throw.bpmn': 'message-throw-to-callback.bpmn',
  'subprocess.bpmn': 'embedded-subprocess-minimal.bpmn',
  'linear-service-and-user-task.bpmn': 'linear-service-and-user-task.bpmn',
  'xor-with-transition-conditions.bpmn': 'xor-with-transition-conditions.bpmn',
  'tri-tool-linear.bpmn': 'tri-tool-linear.bpmn',
  'input-sequence.bpmn': 'input-sequence.bpmn',
  'input-sequence-with-assess.bpmn': 'input-sequence-with-assess.bpmn',
  'input-sequence-with-subprocess.bpmn': 'input-sequence-with-subprocess.bpmn',
};

export function loadBpmn(modelFile: string): string {
  const filename = BPMN_FILES[modelFile] ?? modelFile.replace(/^test\/bpmn\//, '');
  return readFileSync(join(__dirname, '../bpmn', filename), 'utf-8');
}

export type TestContext = {
  db: Db;
  definitionId: string;
  instanceId: string;
};

/** Set PURGE_DB=true or PURGE_DB=1 to drop the database before/between tests. Default: keep data for analysis. */
export function shouldPurgeDb(): boolean {
  const v = process.env.PURGE_DB ?? '';
  return v === 'true' || v === '1';
}

export async function setupDb(): Promise<Db> {
  require('dotenv').config();
  process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017?serverSelectionTimeoutMS=5000';
  process.env.MONGO_DB = process.env.MONGO_DB ?? 'BPM';
  const db = await connectDb();
  if (shouldPurgeDb()) {
    await db.dropDatabase();
  }
  await ensureIndexes(db);
  return db;
}

export async function teardownDb(): Promise<void> {
  await closeDb();
}

export async function deployAndStart(
  db: Db,
  bpmnFile: string,
  options?: { businessKey?: string; processName?: string; user?: typeof MOCK_USER }
): Promise<TestContext> {
  const bpmn = loadBpmn(bpmnFile);
  const name = options?.processName ?? 'Test';
  const { definitionId } = await deployDefinition(db, { name, version: 1, bpmnXml: bpmn });
  const { instanceId } = await startInstance(db, {
    commandId: uuidv4(),
    definitionId,
    businessKey: options?.businessKey,
    tenantId: undefined,
    user: options?.user,
  });
  return { db, definitionId, instanceId };
}

export async function completeWorkItem(
  db: Db,
  instanceId: string,
  workItemId: string,
  options?: { user?: typeof MOCK_USER; result?: Record<string, unknown> }
): Promise<void> {
  const { Continuations } = getCollections(db);
  const payload: Record<string, unknown> = { workItemId, commandId: uuidv4() };
  if (options?.result) payload.result = options.result;
  if (options?.user) {
    payload.completedBy = options.user.email;
    payload.completedByDetails = options.user;
  }
  await Continuations.insertOne({
    _id: uuidv4(),
    instanceId,
    dueAt: new Date(),
    kind: 'WORK_COMPLETED',
    payload,
    status: 'READY',
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function submitDecision(
  db: Db,
  instanceId: string,
  decisionId: string,
  selectedFlowIds: string[]
): Promise<void> {
  const { Continuations } = getCollections(db);
  await Continuations.insertOne({
    _id: uuidv4(),
    instanceId,
    dueAt: new Date(),
    kind: 'DECISION_RECORDED',
    payload: { decisionId, selectedFlowIds, commandId: uuidv4() },
    status: 'READY',
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function getEvents(db: Db, instanceId: string) {
  const { ProcessInstanceEvents } = getCollections(db);
  return ProcessInstanceEvents.find({ instanceId }).sort({ seq: 1 }).toArray();
}

export async function getState(db: Db, instanceId: string) {
  const { ProcessInstanceState } = getCollections(db);
  return ProcessInstanceState.findOne({ _id: instanceId });
}

/** Get worklist tasks (human_tasks projection). Pass filters like { status: 'OPEN' } or { instanceId }. */
export async function getWorklistTasks(
  db: Db,
  filter: { status?: string; instanceId?: string; assigneeUserId?: string } = {}
) {
  const { HumanTasks } = getCollections(db);
  const q: Record<string, unknown> = {};
  if (filter.status) q.status = filter.status;
  if (filter.instanceId) q.instanceId = filter.instanceId;
  if (filter.assigneeUserId) q.assigneeUserId = filter.assigneeUserId;
  return HumanTasks.find(q).sort({ createdAt: -1 }).toArray();
}

/** Activate a worklist task (OPEN → CLAIMED). Blocks other users from activating. */
export async function activateWorklistTask(
  db: Db,
  taskId: string,
  userId: string
): Promise<import('../../src/db/collections').HumanTaskDoc | null> {
  const { HumanTasks } = getCollections(db);
  const now = new Date();
  return HumanTasks.findOneAndUpdate(
    { _id: taskId, status: 'OPEN' },
    {
      $set: { status: 'CLAIMED', assigneeUserId: userId, claimedAt: now },
      $inc: { version: 1 },
    },
    { returnDocument: 'after' }
  );
}

export function assertMonotonicEvents(events: { seq: number }[]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
  }
}

export function assertNoDuplicateTokens(state: { tokens?: { tokenId: string }[] }): void {
  const ids = (state?.tokens ?? []).map((t) => t.tokenId);
  expect(new Set(ids).size).toBe(ids.length);
}
