/**
 * BPMN Conformance Test Matrix - see readme/TEST.md
 * Uses mock callbacks with log output per spec.
 * Requires MongoDB (MONGO_URL).
 * Each test deploys with a unique process name so runs don't require purging.
 * Uses BpmnEngineClient.processUntilComplete (event-driven, no polling).
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { BpmnEngineClient } from '../../src/sdk/client';
import { ensureIndexes } from '../../src/db/indexes';
import {
  setupDb,
  teardownDb,
  deployAndStart,
  getEvents,
  getState,
  mockCallbacks,
  assertMonotonicEvents,
  assertNoDuplicateTokens,
  BPMN_FILES,
  shouldPurgeDb,
  MOCK_USER,
} from './helpers';

const LINEAR = 'linear.bpmn';
const XOR = 'xor-split-with-default.bpmn';
const AND = 'and-split-join.bpmn';

function bpmnFile(key: string): string {
  return BPMN_FILES[key] ?? key;
}

let db: Db;
let client: BpmnEngineClient;
let runId: string;

beforeAll(async () => {
  jest.setTimeout(10000);
  runId = uuidv4().slice(0, 8);
  db = await setupDb();
  client = new BpmnEngineClient({ mode: 'local', db });
}, 10000);

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  mockCallbacks.reset();
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

describe('T01 - Simple linear flow', () => {
  it('Start → complete Task_A: instance completes', async () => {
    const modelFile = bpmnFile(LINEAR);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T01_Linear_${runId}`,
      user: MOCK_USER,
    });

    const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
      const state = await getState(db, instanceId);
      mockCallbacks.log('workItem', state?.waits?.workItems?.[0]);
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    };
    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: completeWork,
      onServiceCall: completeWork,
    });

    expect(result.status).toBe('COMPLETED');
    const finalState = await getState(db, instanceId);
    const events = await getEvents(db, instanceId);
    const tokenCreated = events.filter((e) => e.type === 'TOKEN_CREATED');
    expect(tokenCreated.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'INSTANCE_COMPLETED')).toBe(true);
    assertMonotonicEvents(events);
    assertNoDuplicateTokens(finalState!);
  });
});

describe('T02 - XOR branch selected', () => {
  it('Decision returns Flow_A: Task_A created, Task_B not created', async () => {
    const modelFile = bpmnFile(XOR);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T02_XOR_${runId}`,
      user: MOCK_USER,
    });

    const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    };
    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: completeWork,
      onServiceCall: completeWork,
      onDecision: async (item) => {
        const p = item.payload as { decisionId?: string; evaluation?: { outgoing?: { flowId: string }[] } };
        const decisionId = p.decisionId;
        const flowIds = p.evaluation?.outgoing?.map((o) => o.flowId) ?? [];
        mockCallbacks.log('decision', { decisionId, flowIds });
        if (decisionId && flowIds.includes('Flow_A')) {
          await client.submitDecision(item.instanceId, decisionId, { selectedFlowIds: ['Flow_A'] });
        }
      },
    });

    expect(result.status).toBe('COMPLETED');
    const afterEvents = await getEvents(db, instanceId);
    const afterState = await getState(db, instanceId);
    expect(afterEvents.some((e) => e.type === 'DECISION_REQUESTED')).toBe(true);
    expect(afterEvents.some((e) => e.type === 'INSTANCE_FAILED')).toBe(false);
    const tokenCreatedAfter = afterEvents.filter(
      (e) => e.type === 'TOKEN_CREATED' && (e.payload as { nodeId?: string }).nodeId === 'Task_A'
    );
    expect(tokenCreatedAfter.length).toBe(1);
    expect(afterEvents.some((e) => e.type === 'DECISION_RECORDED')).toBe(true);
    assertMonotonicEvents(afterEvents);
    assertNoDuplicateTokens(afterState!);
  });
});

describe('T03 - XOR default branch', () => {
  it.skip('Decision returns empty: Task_B created (default flow)', async () => {
    // Requires default flow support - skip if not implemented
  });
});

describe('T04 - Parallel split/join', () => {
  it('Complete only Task_A: instance remains RUNNING', async () => {
    const modelFile = bpmnFile(AND);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T04_AND_${runId}`,
      user: MOCK_USER,
    });

    const completeTaskAOnly = async (item: { instanceId: string; payload: { workItemId: string; nodeId?: string } }) => {
      if (item.payload.nodeId === 'Task_A') {
        await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
      }
    };
    await client.processUntilComplete(instanceId, {
      onWorkItem: completeTaskAOnly,
      onServiceCall: completeTaskAOnly,
    });

    const afterState = await getState(db, instanceId);
    expect(afterState?.status).toBe('RUNNING');
    expect(afterState?.waits?.workItems).toHaveLength(1);
    assertMonotonicEvents(await getEvents(db, instanceId));
  });
});

describe('T05 - Parallel join fires', () => {
  it('Complete Task_A and Task_B: instance completes', async () => {
    const modelFile = bpmnFile(AND);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T05_AND_${runId}`,
      user: MOCK_USER,
    });

    const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    };
    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: completeWork,
      onServiceCall: completeWork,
    });

    expect(result.status).toBe('COMPLETED');
    const finalState = await getState(db, instanceId);
    assertMonotonicEvents(await getEvents(db, instanceId));
    assertNoDuplicateTokens(finalState!);
  });
});

describe('T06-T07 - OR split/join', () => {
  it.skip('OR single branch - requires OR gateway', async () => {});
  it.skip('OR multiple branches - requires OR gateway', async () => {});
});

const noopHandlers = {
  onWorkItem: async () => {},
  onServiceCall: async () => {},
};

describe('T08 - Intermediate timer', () => {
  it('Token waits until the timer is due, then the instance completes', async () => {
    const { instanceId } = await deployAndStart(db, bpmnFile('intermediate-timer.bpmn'), {
      processName: `T08_Timer_${runId}`,
      user: MOCK_USER,
    });

    // Before PT1S elapses there is nothing claimable: the instance waits.
    const first = await client.processUntilComplete(instanceId, noopHandlers);
    expect(first.status).toBe('RUNNING');
    const waiting = await getState(db, instanceId);
    expect(waiting!.waits.timers).toHaveLength(1);
    expect(waiting!.waits.timers[0]!.nodeId).toBe('Timer_1');
    expect(waiting!.tokens.find((t) => t.nodeId === 'Timer_1')?.status).toBe('WAITING');
    const due = waiting!.waits.timers[0]!.dueAt.getTime();
    expect(due - waiting!.waits.timers[0]!.createdAt.getTime()).toBe(1000);

    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now()) + 50));
    const second = await client.processUntilComplete(instanceId, noopHandlers);
    expect(second.status).toBe('COMPLETED');

    const finalState = await getState(db, instanceId);
    expect(finalState!.waits.timers).toHaveLength(0);
    const events = await getEvents(db, instanceId);
    const types = events.map((e) => e.type);
    expect(types).toContain('TIMER_SCHEDULED');
    expect(types).toContain('TIMER_FIRED');
    expect(types.indexOf('TIMER_FIRED')).toBeGreaterThan(types.indexOf('TIMER_SCHEDULED'));
    assertMonotonicEvents(events);
    assertNoDuplicateTokens(finalState!);
  });
});

describe('T09-T10 - Boundary timer', () => {
  it.skip('Interrupting timer - requires boundary timer', async () => {});
  it.skip('Normal completion before timer - requires boundary timer', async () => {});
});

describe('T11-T12 - Boundary error', () => {
  it.skip('Boundary error triggered - requires error handling', async () => {});
  it.skip('No error - requires error handling', async () => {});
});

describe('T13-T14 - Message catch', () => {
  const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
    await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
  };

  it('Message resumes token; a repeated messageId is applied once', async () => {
    const { instanceId } = await deployAndStart(db, bpmnFile('message-catch.bpmn'), {
      processName: `T13_Message_${runId}`,
      user: MOCK_USER,
    });
    const first = await client.processUntilComplete(instanceId, { onServiceCall: completeWork });
    expect(first.status).toBe('RUNNING');
    const waiting = await getState(db, instanceId);
    expect(waiting!.waits.messageSubs).toHaveLength(1);
    expect(waiting!.waits.messageSubs[0]!.messageName).toBe('OrderPaid');

    const delivered = await client.deliverMessage(instanceId, {
      messageName: 'OrderPaid',
      messageId: 'pay-1',
      data: { amount: 42 },
    });
    expect(delivered.subscribed).toBe(true);
    // The same message again (e.g. a retried webhook) must not do anything.
    await client.deliverMessage(instanceId, { messageName: 'OrderPaid', messageId: 'pay-1' });

    const done = await client.processUntilComplete(instanceId, { onServiceCall: completeWork });
    expect(done.status).toBe('COMPLETED');
    const events = await getEvents(db, instanceId);
    const received = events.filter((e) => e.type === 'MESSAGE_RECEIVED');
    expect(received).toHaveLength(1);
    expect(received[0]!.payload).toMatchObject({ messageName: 'OrderPaid', data: { amount: 42 } });
    expect(events.filter((e) => e.type === 'WORK_ITEM_COMPLETED')).toHaveLength(1);
    assertMonotonicEvents(events);
  });

  it('Non-matching message is discarded and the token keeps waiting', async () => {
    const { instanceId } = await deployAndStart(db, bpmnFile('message-catch.bpmn'), {
      processName: `T14_Message_${runId}`,
      user: MOCK_USER,
    });
    await client.processUntilComplete(instanceId, { onServiceCall: completeWork });

    const res = await client.deliverMessage(instanceId, { messageName: 'OrderCancelled' });
    expect(res.subscribed).toBe(false);
    const after = await client.processUntilComplete(instanceId, { onServiceCall: completeWork });
    expect(after.status).toBe('RUNNING');

    const state = await getState(db, instanceId);
    expect(state!.waits.messageSubs).toHaveLength(1);
    const events = await getEvents(db, instanceId);
    expect(events.some((e) => e.type === 'MESSAGE_DISCARDED')).toBe(true);
    expect(events.some((e) => e.type === 'MESSAGE_RECEIVED')).toBe(false);
  });
});

describe('T15 - Message throw', () => {
  it.skip('Message throw - requires message throw + outbox', async () => {});
});

describe('T16 - Embedded subprocess', () => {
  it('Subprocess: complete inner task, scope ends, process completes', async () => {
    const modelFile = bpmnFile('subprocess.bpmn');
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T16_Subprocess_${runId}`,
      user: MOCK_USER,
    });

    const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    };
    const result = await client.processUntilComplete(instanceId, {
      onServiceCall: completeWork,
    });

    expect(result.status).toBe('COMPLETED');
    const events = await getEvents(db, instanceId);
    expect(events.some((e) => e.type === 'SCOPE_CREATED' && (e.payload as { kind?: string }).kind === 'SUBPROCESS')).toBe(true);
    expect(events.some((e) => e.type === 'SCOPE_ENDED' && (e.payload as { kind?: string }).kind === 'SUBPROCESS')).toBe(true);
  });
});

describe('T17 - Duplicate work completion', () => {
  it('Submit same completion twice: idempotent', async () => {
    const modelFile = bpmnFile(LINEAR);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T17_Linear_${runId}`,
      user: MOCK_USER,
    });

    const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    };
    await client.processUntilComplete(instanceId, {
      onWorkItem: completeWork,
      onServiceCall: completeWork,
    });

    const finalState = await getState(db, instanceId);
    const events = await getEvents(db, instanceId);
    const tokenCreatedCount = events.filter((e) => e.type === 'TOKEN_CREATED').length;
    expect(tokenCreatedCount).toBeLessThanOrEqual(4);
    assertNoDuplicateTokens(finalState!);
  });
});

describe('T18 - Duplicate decision', () => {
  it('Submit same decision twice: idempotent', async () => {
    const modelFile = bpmnFile(XOR);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T18_XOR_${runId}`,
      user: MOCK_USER,
    });

    const completeWork = async (item: { instanceId: string; payload: { workItemId: string } }) => {
      await client.completeWorkItem(item.instanceId, item.payload.workItemId, { user: MOCK_USER });
    };
    await client.processUntilComplete(instanceId, {
      onWorkItem: completeWork,
      onServiceCall: completeWork,
      onDecision: async (item) => {
        const p = item.payload as { decisionId?: string };
        const decisionId = p.decisionId!;
        await client.submitDecision(item.instanceId, decisionId, { selectedFlowIds: ['Flow_A'] });
        await client.submitDecision(item.instanceId, decisionId, { selectedFlowIds: ['Flow_A'] });
      },
    });

    const finalState = await getState(db, instanceId);
    assertNoDuplicateTokens(finalState!);
  });
});

describe('T19 - Worker crash recovery', () => {
  it.skip('Simulate lease expiry - continuation retried', async () => {});
});

describe('T20 - Outbox duplicate delivery', () => {
  it.skip('Simulate dispatcher crash - receiver dedupes', async () => {});
});
