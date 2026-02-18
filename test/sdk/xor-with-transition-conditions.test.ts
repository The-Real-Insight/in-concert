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
  deployAndStart,
  getWorklistTasks,
} from '../scripts/helpers';
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

function uniqueName(base: string) {
  return `${base}_${uuidv4().slice(0, 8)}`;
}

function onCallback(item: CallbackItem) {
  if (item.kind === 'CALLBACK_WORK') {
    const p = item.payload as { workItemId: string; name?: string; lane?: string; nodeId?: string };
    const entry = { name: p.name ?? 'Task', role: p.lane, workItemId: p.workItemId, toolInvocation: undefined };
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
});

afterAll(async () => {
  unsubscribeProjection?.();
  await teardownDb();
});

beforeEach(async () => {
  workCallbacks.length = 0;
  decisionCallbacks.length = 0;
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

describe('SDK: xor-with-transition-conditions', () => {
  it('completes user tasks via callbacks and XOR decision with random transition', async () => {
    const { instanceId } = await deployAndStart(db, 'xor-with-transition-conditions.bpmn', {
      processName: uniqueName('ClaimProcess'),
    });

    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        onCallback(item);
        const p = item.payload as { workItemId: string; nodeId?: string; name?: string; extensions?: Record<string, string> };
        const toolId = p.extensions?.['tri:toolId'];
        const toolType = p.extensions?.['tri:toolType'];
        const tri = toolId && toolType ? { toolId, toolType } : undefined;
        if (tri) {
          workCallbacks[workCallbacks.length - 1]!.toolInvocation = `invoke tool: toolId=${tri.toolId} toolType=${tri.toolType}`;
          console.log(
            '[onWorkItem] TOOL RESOLUTION PLUG: resolve(toolId, toolType) → invoke',
            { toolId: tri.toolId, toolType: tri.toolType, nodeId: p.nodeId, task: p.name, workItemId: p.workItemId }
          );
        }
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
      },
      onDecision: async (item) => {
        onCallback(item);
        const p = item.payload as { evaluation?: { outgoing?: { flowId: string }[] } };
        const flowIds = p.evaluation?.outgoing?.map((o) => o.flowId) ?? [];
        if (flowIds.length > 0) {
          const randomFlowId = flowIds[Math.floor(Math.random() * flowIds.length)]!;
          await client.submitDecision(item.instanceId, (p as { decisionId?: string }).decisionId!, {
            selectedFlowIds: [randomFlowId],
          });
        }
      },
    });

    expect(result.status).toBe('COMPLETED');

    // Verify user tasks were completed
    expect(workCallbacks.some((w) => w.name === 'Claim Entry' && w.role === 'Beneficiary')).toBe(true);
    expect(workCallbacks.some((w) => w.name === 'Claim Assessment' && w.role === 'Claims Assessor')).toBe(true);

    // Verify XOR decision was handled with LLM-friendly metadata
    expect(decisionCallbacks.length).toBeGreaterThanOrEqual(1);
    const xorPayload = decisionCallbacks[0]!;
    expect(xorPayload.flowIds).toContain('Flow_Rejection');
    expect(xorPayload.flowIds).toContain('Flow_Approval');
    expect(xorPayload.toNodeIds).toContain('Task_SendRejectionMail');
    expect(xorPayload.toNodeIds).toContain('Task_SendApprovalMail');
    expect(xorPayload.gateway?.id).toBe('Gateway_Approval');
    expect(xorPayload.gateway?.name).toBe('Can be approved?');
    const rejection = xorPayload.transitions?.find((t) => t.flowId === 'Flow_Rejection');
    const approval = xorPayload.transitions?.find((t) => t.flowId === 'Flow_Approval');
    expect(rejection?.isDefault).toBe(true);
    expect(rejection?.name).toBe('No');
    expect(rejection?.targetNodeName).toBe('Send Rejection Mail');
    expect(approval?.name).toBe('Yes');
    expect(approval?.conditionExpression).toBe('${approved}');
    expect(approval?.targetNodeName).toBe('Send Approval Mail');

    // Service tasks with tri:toolId/toolType indicate tool invocation
    const mailTasks = workCallbacks.filter((w) => w.toolInvocation);
    expect(mailTasks.length).toBeGreaterThanOrEqual(1);
    expect(mailTasks.some((w) => w.toolInvocation?.includes('mailTool'))).toBe(true);
  });

  it('processUntilComplete projects user tasks to worklist', async () => {
    const { instanceId } = await deployAndStart(db, 'xor-with-transition-conditions.bpmn', {
      processName: uniqueName('ClaimWorklist'),
    });

    // Complete Claim Entry, leave Claim Assessment for worklist verification
    await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        const name = (item.payload as { name?: string }).name;
        if (name === 'Claim Assessment') return;
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
      },
    });

    const openTasks = await getWorklistTasks(db, { instanceId, status: 'OPEN' });
    const claimAssessment = openTasks.find((t) => t.name === 'Claim Assessment');
    expect(claimAssessment).toBeDefined();
    expect(claimAssessment!.role).toBe('Claims Assessor');
    expect(claimAssessment!.candidateRoles).toContain('Claims Assessor');
  });
});
