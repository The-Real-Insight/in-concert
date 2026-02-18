/**
 * SDK test: linear-service-and-user-task process.
 * Tests invocation/execution and logs callbacks with task properties (name, role/lane).
 * Includes worklist test: leave user tasks uncompleted and retrieve via HumanTasks projection.
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
  getWorklistTasks,
  MOCK_USER,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;
let unsubscribeProjection: (() => void) | null = null;

const callbackLog: Array<{
  kind: string;
  name?: string;
  role?: string;
  workItemId: string;
  toolInvocation?: string;
}> = [];

/** Per-run config: tests set before client.run(). Central handlers read this. */
let runConfig: { skipTaskNames?: string[] } = {};

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  unsubscribeProjection = addStreamHandler(createProjectionHandler(db));

  client.init({
    onWorkItem: async (item) => {
      onCallback(item);
      const name = (item.payload as { name?: string }).name;
      if (runConfig.skipTaskNames?.includes(name ?? '')) return;
      await client.completeUserTask(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    },
    onServiceCall: async (item) => {
      onCallback(item);
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });
});

afterAll(async () => {
  unsubscribeProjection?.();
  await teardownDb();
});

beforeEach(async () => {
  callbackLog.length = 0;
  runConfig = {};
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
    const payload = item.payload as {
      workItemId: string;
      name?: string;
      lane?: string;
      nodeId?: string;
      extensions?: Record<string, string>;
    };
    const toolId = payload.extensions?.['tri:toolId'];
    const toolType = payload.extensions?.['tri:toolType'];
    const toolInvocation =
      toolId && toolType ? `invoke tool: toolId=${toolId} toolType=${toolType}` : undefined;
    const entry = {
      kind: 'CALLBACK_WORK',
      name: payload.name,
      role: payload.lane,
      workItemId: payload.workItemId,
      toolInvocation,
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
      user: MOCK_USER,
    });

    const result = await client.run(instanceId);

    expect(result.status).toBe('COMPLETED');
    const expectedOrder = [
      { name: 'EnterCaseData', role: 'FrontOffice' },
      { name: 'AssessCase', role: undefined },
      { name: 'ApproveAssessment', role: 'BackOffice' },
      { name: 'InitiatePayment', role: 'Accounting' },
    ];
    expect(callbackLog).toHaveLength(4);
    expect(callbackLog.map((c) => ({ name: c.name, role: c.role }))).toEqual(
      expectedOrder.map((e) => ({ name: e.name, role: e.role }))
    );
  });

  it('leaves ApproveAssessment uncompleted and retrieves worklist', async () => {
    const bpmn = loadBpmn('linear-service-and-user-task.bpmn');
    const { definitionId } = await client.deploy({
      name: uniqueName('WorklistTest'),
      version: 1,
      bpmnXml: bpmn,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    // Process with callbacks: complete EnterCaseData and AssessCase, leave ApproveAssessment
    runConfig = { skipTaskNames: ['ApproveAssessment'] };
    await client.run(instanceId);

    const openTasks = await getWorklistTasks(db, { status: 'OPEN' });
    const approveTask = openTasks.find((t) => t.name === 'ApproveAssessment' && t.instanceId === instanceId);
    expect(approveTask).toBeDefined();
    expect(approveTask!.status).toBe('OPEN');
    expect(approveTask!.role).toBe('BackOffice');
    expect(approveTask!.candidateRoles).toContain('BackOffice');

    // EnterCaseData should be COMPLETED in projection
    const completedTasks = await getWorklistTasks(db, { instanceId });
    const completedEnter = completedTasks.find((t) => t.name === 'EnterCaseData');
    expect(completedEnter?.status).toBe('COMPLETED');
  });

  it('tri-tool model: extensions in payload, callback looks up tri: and indicates tool invocation', async () => {
    const bpmn = loadBpmn('tri-tool-linear.bpmn');
    const { definitionId } = await client.deploy({
      name: uniqueName('TriTool'),
      version: 1,
      bpmnXml: bpmn,
    });

    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    const result = await client.run(instanceId);

    expect(result.status).toBe('COMPLETED');
    expect(callbackLog).toHaveLength(1);
    expect(callbackLog[0]!.name).toBe('Test - BPMN');
    expect(callbackLog[0]!.toolInvocation).toBe(
      'invoke tool: toolId=696272408e106ae502e3d791 toolType=promptTool'
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
      user: MOCK_USER,
    });

    let unsub: () => void;
    await new Promise<void>((resolve) => {
      unsub = client.subscribeToCallbacks((item) => {
        if (item.instanceId !== instanceId) return;
        onCallback(item);
        if (callbackLog.some((c) => c.name === 'EnterCaseData')) {
          unsub!();
          resolve();
        }
      });
    });

    expect(callbackLog.length).toBeGreaterThanOrEqual(1);
    expect(callbackLog[0]!.name).toBe('EnterCaseData');
    expect(callbackLog[0]!.role).toBe('FrontOffice');

    // Complete first work item (subscribe logged but did not complete), then process rest
    await client.completeUserTask(instanceId, callbackLog[0]!.workItemId, { user: MOCK_USER });
    await client.run(instanceId);
  });
});
