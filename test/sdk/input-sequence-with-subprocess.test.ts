/**
 * SDK test: input-sequence-with-subprocess process.
 * Root: input-a → assess-a → input-b → assess-b → input-c → assess-c
 *       → subprocess (input-d → assess-d → input-e → assess-e)
 *       → calculate-results → end
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import {
  setupDb,
  teardownDb,
  shouldPurgeDb,
  loadBpmn,
  getEvents,
  getState,
  MOCK_USER,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;
let unsubscribeProjection: (() => void) | null = null;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  unsubscribeProjection = addStreamHandler(createProjectionHandler(db));

  client.init({
    onWorkItem: async (item) => {
      await client.completeUserTask(item.instanceId, item.payload.workItemId, {
        user: MOCK_USER,
        result: { value: 'test-data' },
      });
    },
    onServiceCall: async (item) => {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });
});

afterAll(async () => {
  unsubscribeProjection?.();
  await teardownDb();
});

beforeEach(async () => {
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

function uniqueName(base: string) {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

describe('SDK: input-sequence-with-subprocess', () => {
  it('input-sequence-with-assess (no subprocess) completes as baseline', async () => {
    const bpmn = loadBpmn('input-sequence-with-assess.bpmn');
    const name = uniqueName('AssessBaseline');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });
    const result = await client.run(instanceId);
    expect(result.status).toBe('COMPLETED');
  });

  it('executes full process: root sequence, subprocess, then calculate-results', async () => {
    const bpmn = loadBpmn('input-sequence-with-subprocess.bpmn');
    const name = uniqueName('SubprocessTest');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    const result = await client.run(instanceId);

    expect(result.status).toBe('COMPLETED');

    const state = await getState(db, instanceId);
    expect(state?.status).toBe('COMPLETED');

    const events = await getEvents(db, instanceId);
    const scopeCreated = events.filter((e) => e.type === 'SCOPE_CREATED');
    const scopeEnded = events.filter((e) => e.type === 'SCOPE_ENDED');
    expect(scopeCreated.some((e) => (e.payload as { kind?: string }).kind === 'SUBPROCESS')).toBe(true);
    expect(scopeEnded.some((e) => (e.payload as { kind?: string }).kind === 'SUBPROCESS')).toBe(true);

    const workCompleted = events.filter((e) => e.type === 'WORK_ITEM_COMPLETED');
    const completedNodeIds = workCompleted.map((e) => (e.payload as { nodeId?: string }).nodeId);
    expect(completedNodeIds).toContain('Task_InputA');
    expect(completedNodeIds).toContain('Task_InputB');
    expect(completedNodeIds).toContain('Task_InputC');
    expect(completedNodeIds).toContain('Task_InputD');
    expect(completedNodeIds).toContain('Task_InputE');
    expect(completedNodeIds).toContain('Task_AssessA');
    expect(completedNodeIds).toContain('Task_AssessB');
    expect(completedNodeIds).toContain('Task_AssessC');
    expect(completedNodeIds).toContain('Task_AssessD');
    expect(completedNodeIds).toContain('Task_AssessE');
    expect(completedNodeIds).toContain('Task_CalculateResults');

    const history = await client.getProcessHistory(instanceId);
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((h) => h.eventType === 'INSTANCE_STARTED')).toBe(true);
    expect(history.some((h) => h.eventType === 'TASK_STARTED')).toBe(true);
    expect(history.some((h) => h.eventType === 'TASK_COMPLETED')).toBe(true);
  });
});
