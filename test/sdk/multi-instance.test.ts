/**
 * Multi-instance execution tests.
 * Uses dummy callbacks with fixed arrays to verify executionIndex, loopCounter, totalItems.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import type { CallbackItem, CallbackWorkPayload } from '../../src/sdk/types';
import {
  setupDb,
  teardownDb,
  shouldPurgeDb,
  loadBpmn,
  MOCK_USER,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;
let unsubscribeProjection: (() => void) | null = null;

const workCallbacks: Array<{
  workItemId: string;
  name?: string;
  executionIndex?: number;
  loopCounter?: number;
  totalItems?: number;
  multiInstanceData?: string;
}> = [];
const resolveCallbacks: Array<{ nodeId: string; instanceId: string }> = [];

function uniqueName(base: string) {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  unsubscribeProjection = addStreamHandler(createProjectionHandler(db));

  const FIXED_ITEMS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  client.init({
    onMultiInstanceResolve: async (item) => {
      resolveCallbacks.push({
        nodeId: item.payload.nodeId,
        instanceId: item.instanceId,
      });
      return { items: FIXED_ITEMS };
    },
    onWorkItem: async (item) => {
      if (item.kind === 'CALLBACK_WORK') {
        const p = item.payload as CallbackWorkPayload;
        workCallbacks.push({
          workItemId: p.workItemId,
          name: p.name,
          executionIndex: p.executionIndex,
          loopCounter: p.loopCounter,
          totalItems: p.totalItems,
          multiInstanceData: p.multiInstanceData,
        });
        await client.completeUserTask(item.instanceId, p.workItemId, { user: MOCK_USER });
      }
    },
    onServiceCall: async (item) => {
      if (item.kind === 'CALLBACK_WORK') {
        const p = item.payload as CallbackWorkPayload;
        workCallbacks.push({
          workItemId: p.workItemId,
          name: p.name,
          executionIndex: p.executionIndex,
          loopCounter: p.loopCounter,
          totalItems: p.totalItems,
          multiInstanceData: p.multiInstanceData,
        });
        await client.completeExternalTask(item.instanceId, p.workItemId);
      }
    },
  });
});

afterAll(async () => {
  unsubscribeProjection?.();
  await teardownDb();
});

beforeEach(async () => {
  workCallbacks.length = 0;
  resolveCallbacks.length = 0;
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

describe('SDK: multi-instance', () => {
  it('emits onMultiInstanceResolve, then N work callbacks with executionIndex', async () => {
    const bpmn = loadBpmn('multi-instance-service-task.bpmn');
    const name = uniqueName('MultiInstance');
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
    expect(resolveCallbacks).toHaveLength(1);
    expect(resolveCallbacks[0]!.nodeId).toBe('Activity_MI');

    expect(workCallbacks).toHaveLength(3);
    expect(workCallbacks[0]).toMatchObject({
      name: 'Process Items',
      executionIndex: 0,
      loopCounter: 1,
      totalItems: 3,
    });
    expect(workCallbacks[1]).toMatchObject({
      executionIndex: 1,
      loopCounter: 2,
      totalItems: 3,
    });
    expect(workCallbacks[2]).toMatchObject({
      executionIndex: 2,
      loopCounter: 3,
      totalItems: 3,
    });
    expect(workCallbacks.every((c) => c.multiInstanceData === 'processList')).toBe(true);
  });

  it('handler can use executionIndex to access item from resolve callback', async () => {
    const FIXED_ITEMS = [{ id: 'x', label: 'First' }, { id: 'y', label: 'Second' }];
    const resolvedItems: unknown[] = [];

    const testClient = new BpmnEngineClient({ mode: 'local', db });
    testClient.init({
      onMultiInstanceResolve: async () => ({ items: FIXED_ITEMS }),
      onServiceCall: async (item) => {
        if (item.kind === 'CALLBACK_WORK') {
          const p = item.payload as CallbackWorkPayload;
          const idx = p.executionIndex;
          if (idx != null && idx < FIXED_ITEMS.length) {
            resolvedItems.push(FIXED_ITEMS[idx]);
          }
          await testClient.completeExternalTask(item.instanceId, p.workItemId);
        }
      },
    });

    const bpmn = loadBpmn('multi-instance-service-task.bpmn');
    const name = uniqueName('MI_Index');
    const { definitionId } = await testClient.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });

    const { instanceId } = await testClient.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    await testClient.run(instanceId);

    expect(resolvedItems).toEqual(FIXED_ITEMS);
  });
});
