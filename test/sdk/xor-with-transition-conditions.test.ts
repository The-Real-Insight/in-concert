/**
 * SDK test: xor-with-transition-conditions process.
 * - User tasks: Claim Entry (Beneficiary), Claim Assessment (Claims Assessor)
 * - XOR split: gateway "Can be approved?" → Yes / No transitions
 *   - No (default) → Send Rejection Mail
 *   - Yes (${approved}) → Send Approval Mail
 * - Callbacks pick up user tasks and complete them
 * - XOR decision callback shows gateway question + transition labels (LLM-friendly)
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
  MOCK_USER,
} from '../scripts/helpers';
import { getCollections } from '../../src/db/collections';
import { ensureIndexes } from '../../src/db/indexes';
import { addStreamHandler } from '../../src/ws/broadcast';
import { createProjectionHandler } from '../../src/worklist/projection';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;
let unsubscribeProjection: (() => void) | null = null;

const workCallbacks: Array<{
  name: string;
  role?: string;
  workItemId: string;
  toolInvocation?: string;
}> = [];
const decisionCallbacks: Array<{
  decisionId: string;
  flowIds: string[];
  toNodeIds: string[];
  gateway?: { id: string; name?: string };
  transitions?: Array<{ flowId: string; name?: string; conditionExpression?: string; isDefault: boolean; targetNodeName?: string }>;
}> = [];

/** Per-run config: tests set before client.run(). Central handlers read this. */
let runConfig: { skipTaskNames?: string[]; selectFlowIds?: (flowIds: string[]) => string[] } = {};

function uniqueName(base: string) {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

function onCallback(item: CallbackItem) {
  if (item.kind === 'CALLBACK_WORK') {
    const p = item.payload as {
      workItemId: string;
      name?: string;
      lane?: string;
      nodeId?: string;
      extensions?: Record<string, string>;
    };
    const toolId = p.extensions?.['tri:toolId'];
    const toolType = p.extensions?.['tri:toolType'];
    const toolInvocation =
      toolId && toolType ? `invoke tool: toolId=${toolId} toolType=${toolType}` : undefined;
    const entry = { name: p.name ?? 'Task', role: p.lane, workItemId: p.workItemId, toolInvocation };
    workCallbacks.push(entry);
    console.log('[Callback]', entry);
  }
  if (item.kind === 'CALLBACK_DECISION') {
    const p = item.payload as {
      decisionId?: string;
      gateway?: { id: string; name?: string };
      transitions?: Array<{ flowId: string; name?: string; conditionExpression?: string; isDefault: boolean; targetNodeName?: string }>;
      evaluation?: { outgoing?: { flowId: string; toNodeId: string }[] };
    };
    const transitions = p.transitions ?? p.evaluation?.outgoing ?? [];
    const entry = {
      decisionId: p.decisionId ?? '',
      flowIds: transitions.map((o) => o.flowId),
      toNodeIds: transitions.map((o) => (o as { toNodeId?: string }).toNodeId ?? ''),
      gateway: p.gateway,
      transitions: p.transitions,
    };
    decisionCallbacks.push(entry);
    console.log('[Callback] XOR decision', entry);
  }
}

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
    onDecision: async (item) => {
      onCallback(item);
      const p = item.payload as { evaluation?: { outgoing?: { flowId: string }[] }; decisionId?: string };
      const flowIds = p.evaluation?.outgoing?.map((o) => o.flowId) ?? [];
      if (flowIds.length > 0) {
        const selected = runConfig.selectFlowIds ? runConfig.selectFlowIds(flowIds) : [flowIds[Math.floor(Math.random() * flowIds.length)]!];
        await client.submitDecision(item.instanceId, p.decisionId!, { selectedFlowIds: selected });
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
  decisionCallbacks.length = 0;
  runConfig = {};
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

describe('SDK: xor-with-transition-conditions', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('worklist flow: start → wait → load → activate → complete, repeat for each user task', async () => {
    const bpmn = loadBpmn('xor-with-transition-conditions.bpmn');
    const name = uniqueName('ClaimProcess');
    const { definitionId } = await client.deploy({
      id: name,
      name,
      version: '1',
      bpmnXml: bpmn,
    });

    // 1. Process start
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
      user: MOCK_USER,
    });

    runConfig = { skipTaskNames: ['Claim Entry', 'Claim Assessment'], selectFlowIds: () => ['Flow_Approval'] };

    let result = await client.run(instanceId);

    while (result.status === 'RUNNING') {
      // 2. Wait for projection
      await sleep(5000);

      // 3. Load worklist
      const openTasks = await client.listTasks({ instanceId, status: 'OPEN', sortOrder: 'asc' });
      if (openTasks.length === 0) {
        result = await client.run(instanceId);
        continue;
      }

      const task = openTasks[openTasks.length - 1]!;

      // 4. Activate (claim)
      const activated = await client.activateTask(task._id, { userId: MOCK_USER.email });
      expect(activated).toBeTruthy();

      // 5. Complete
      await client.completeUserTask(instanceId, task._id, { user: MOCK_USER });

      result = await client.run(instanceId);
    }

    expect(result.status).toBe('COMPLETED');

    expect(workCallbacks.some((w) => w.name === 'Claim Entry' && w.role === 'Beneficiary')).toBe(true);
    expect(workCallbacks.some((w) => w.name === 'Claim Assessment' && w.role === 'Claims Assessor')).toBe(true);
    expect(decisionCallbacks.length).toBeGreaterThanOrEqual(1);
    const mailTasks = workCallbacks.filter((w) => w.toolInvocation);
    expect(mailTasks.length).toBeGreaterThanOrEqual(1);
  });

  it('stores startedBy/startedByDetails on instance and completedBy/completedByDetails on human tasks', async () => {
    const bpmn = loadBpmn('xor-with-transition-conditions.bpmn');
    const name = uniqueName('UserAudit');
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

    // Complete Claim Entry, submit decision to reach Claim Assessment, then stop
    runConfig = { skipTaskNames: ['Claim Assessment'], selectFlowIds: () => ['Flow_Approval'] };
    await client.run(instanceId);

    const { ProcessInstances, HumanTasks } = getCollections(db);
    const instance = await ProcessInstances.findOne({ _id: instanceId });
    expect(instance?.startedBy).toBe(MOCK_USER.email);
    expect(instance?.startedByDetails).toEqual(MOCK_USER);

    const completedTasks = await HumanTasks.find({ instanceId, status: 'COMPLETED' }).toArray();
    const claimEntry = completedTasks.find((t) => t.name === 'Claim Entry');
    expect(claimEntry?.completedBy).toBe(MOCK_USER.email);
    expect(claimEntry?.completedByDetails).toEqual(MOCK_USER);
  });

  it('run projects user tasks to worklist', async () => {
    const bpmn = loadBpmn('xor-with-transition-conditions.bpmn');
    const name = uniqueName('ClaimWorklist');
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

    // Complete Claim Entry, leave Claim Assessment for worklist verification
    runConfig = { skipTaskNames: ['Claim Assessment'], selectFlowIds: () => ['Flow_Approval'] };
    await client.run(instanceId);

    const openTasks = await client.listTasks({ instanceId, status: 'OPEN' });
    const claimAssessment = openTasks.find((t) => t.name === 'Claim Assessment');
    expect(claimAssessment).toBeDefined();
    expect(claimAssessment!.role).toBe('Claims Assessor');
    expect(claimAssessment!.candidateRoles).toContain('Claims Assessor');
  });

  it('init + recover uses registered handlers when recover gets no handlers', async () => {
    const bpmn = loadBpmn('xor-with-transition-conditions.bpmn');
    const name = uniqueName('InitRecover');
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

    runConfig = { selectFlowIds: (ids) => [ids[0]!] };
    const { processed } = await client.recover();
    expect(processed).toBeGreaterThanOrEqual(1);
    const instance = await client.getInstance(instanceId);
    expect(instance?.status).toBe('COMPLETED');
    expect(workCallbacks.some((w) => w.name === 'Claim Entry')).toBe(true);
  });

  it('recover processes all pending continuations after start', async () => {
    const bpmn = loadBpmn('xor-with-transition-conditions.bpmn');
    const name = uniqueName('RecoverTest');
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

    runConfig = { selectFlowIds: (ids) => [ids[0]!] };
    const { processed } = await client.recover();

    expect(processed).toBeGreaterThanOrEqual(1);
    const instance = await client.getInstance(instanceId);
    expect(instance?.status).toBe('COMPLETED');
    expect(workCallbacks.some((w) => w.name === 'Claim Entry')).toBe(true);
    expect(workCallbacks.some((w) => w.name === 'Claim Assessment')).toBe(true);
  });
});
