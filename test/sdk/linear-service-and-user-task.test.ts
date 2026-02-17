/**
 * SDK test: linear-service-and-user-task process.
 * Tests invocation/execution and logs callbacks with task properties (name, role/lane).
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import type { CallbackItem } from '../../src/sdk/types';
import {
  setupDb,
  teardownDb,
  shouldPurgeDb,
  loadBpmn,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;

const callbackLog: Array<{ kind: string; name?: string; role?: string; workItemId: string }> = [];

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  callbackLog.length = 0;
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

function uniqueName(base: string) {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

function onCallback(item: CallbackItem) {
  if (item.kind === 'CALLBACK_WORK') {
    const payload = item.payload as { workItemId: string; name?: string; lane?: string };
    const entry = {
      kind: 'CALLBACK_WORK',
      name: payload.name,
      role: payload.lane,
      workItemId: payload.workItemId,
    };
    callbackLog.push(entry);
    console.log('[Callback]', entry);
  }
}

describe('SDK: linear-service-and-user-task', () => {
  it('executes full process and logs callbacks with name and role', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task.bpmn');
    const { definitionId } = await client.deploy({
      name: uniqueName('CaseProcess'),
      version: 1,
      bpmnXml: bpmn,
    });

    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
    });

    // Process all 4 tasks in sequence
    const expectedOrder = [
      { name: 'EnterCaseData', role: 'FrontOffice' },
      { name: 'AssessCase', role: undefined },
      { name: 'ApproveAssessment', role: 'BackOffice' },
      { name: 'InitiatePayment', role: 'Accounting' },
    ];

    for (let i = 0; i < expectedOrder.length; i++) {
      const n = await client.runWorker(10, (items) => {
        for (const item of items) onCallback(item);
      });
      expect(n).toBeGreaterThanOrEqual(0);

      const state = await client.getState(instanceId);
      const workItem = state?.waits?.workItems?.[0];
      expect(workItem).toBeDefined();
      expect(callbackLog.length).toBe(i + 1);
      expect(callbackLog[i]!.name).toBe(expectedOrder[i]!.name);
      expect(callbackLog[i]!.role).toBe(expectedOrder[i]!.role);

      await client.completeWorkItem(instanceId, workItem!.workItemId);
    }

    await client.runWorker(10);

    const instance = await client.getInstance(instanceId);
    expect(instance?.status).toBe('COMPLETED');

    expect(callbackLog).toHaveLength(4);
    expect(callbackLog.map((c) => ({ name: c.name, role: c.role }))).toEqual(
      expectedOrder.map((e) => ({ name: e.name, role: e.role }))
    );
  });

  it('subscribeToCallbacks receives and logs task properties', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task.bpmn');
    const { definitionId } = await client.deploy({
      name: uniqueName('CaseProcess_Subscribe'),
      version: 1,
      bpmnXml: bpmn,
    });

    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
    });

    const unsubscribe = client.subscribeToCallbacks(onCallback);

    // Wait for first callback (EnterCaseData)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (callbackLog.length >= 1) {
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    unsubscribe();

    expect(callbackLog.length).toBeGreaterThanOrEqual(1);
    expect(callbackLog[0]!.name).toBe('EnterCaseData');
    expect(callbackLog[0]!.role).toBe('FrontOffice');

    // Complete remaining work items to finish the process
    for (let i = 0; i < 4; i++) {
      const state = await client.getState(instanceId);
      const workItem = state?.waits?.workItems?.[0];
      if (!workItem) break;
      await client.completeWorkItem(instanceId, workItem.workItemId);
      await client.runWorker(10);
    }
  });
});
