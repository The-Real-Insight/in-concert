/**
 * Callback demo tests - linear flows with user task and service task.
 * Simulates callback handlers with 10-second delay and console log output.
 * Run separately from conformance: npm run test:callback:user | test:callback:service
 */
import type { Db } from 'mongodb';
import { ensureIndexes } from '../../src/db/indexes';
import { v4 as uuidv4 } from 'uuid';
import {
  setupDb,
  teardownDb,
  deployAndStart,
  runWorker,
  completeWorkItem,
  getState,
  shouldPurgeDb,
} from './helpers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique process name per test run to avoid conflicts when not purging */
function uniqueProcessName(base: string): string {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

let db: Db;

beforeAll(async () => {
  jest.setTimeout(30000);
  db = await setupDb();
}, 15000);

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

describe('Callback demo - User task', () => {
  it('Linear flow with user task: mock logs work item, waits 10s, completes', async () => {
    const { instanceId } = await deployAndStart(db, 'start-user-task-end.bpmn', {
      processName: uniqueProcessName('UserTaskDemo'),
    });

    await runWorker(db);

    const state = await getState(db, instanceId);
    const workItem = state?.waits?.workItems?.[0];
    expect(workItem).toBeDefined();

    console.log('[User task callback] Received work item:', {
      workItemId: workItem!.workItemId,
      nodeId: workItem!.nodeId,
      kind: workItem!.kind,
      instanceId,
    });
    console.log('[User task callback] Simulating human review (10 seconds)...');
    await sleep(10000);
    console.log('[User task callback] Completing work item');

    await completeWorkItem(db, instanceId, workItem!.workItemId);
    await runWorker(db);

    const finalState = await getState(db, instanceId);
    expect(finalState?.status).toBe('COMPLETED');
    console.log('[User task callback] Instance completed successfully');
  });
});

describe('Callback demo - Service task', () => {
  it('Linear flow with service task: mock logs work item, waits 10s, completes', async () => {
    const { instanceId } = await deployAndStart(db, 'start-service-task-end.bpmn', {
      processName: uniqueProcessName('ServiceTaskDemo'),
    });

    await runWorker(db);

    const state = await getState(db, instanceId);
    const workItem = state?.waits?.workItems?.[0];
    expect(workItem).toBeDefined();

    console.log('[Service task callback] Received work item:', {
      workItemId: workItem!.workItemId,
      nodeId: workItem!.nodeId,
      kind: workItem!.kind,
      instanceId,
    });
    console.log('[Service task callback] Simulating application processing (10 seconds)...');
    await sleep(10000);
    console.log('[Service task callback] Completing work item');

    await completeWorkItem(db, instanceId, workItem!.workItemId);
    await runWorker(db);

    const finalState = await getState(db, instanceId);
    expect(finalState?.status).toBe('COMPLETED');
    console.log('[Service task callback] Instance completed successfully');
  });
});
