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
    });

    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        const state = await getState(db, instanceId);
        mockCallbacks.log('workItem', state?.waits?.workItems?.[0]);
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
      },
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
    });

    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
      },
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
    });

    await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        const nodeId = (item.payload as { nodeId?: string }).nodeId;
        if (nodeId === 'Task_A') {
          await client.completeWorkItem(item.instanceId, item.payload.workItemId);
        }
      },
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
    });

    const result = await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
      },
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

describe('T08 - Intermediate timer', () => {
  it.skip('Timer fires - requires timer support', async () => {});
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
  it.skip('Message resumes token - requires message support', async () => {});
  it.skip('Non-matching message - requires message support', async () => {});
});

describe('T15 - Message throw', () => {
  it.skip('Message throw - requires message throw + outbox', async () => {});
});

describe('T16 - Embedded subprocess', () => {
  it.skip('Subprocess - requires subprocess support', async () => {});
});

describe('T17 - Duplicate work completion', () => {
  it('Submit same completion twice: idempotent', async () => {
    const modelFile = bpmnFile(LINEAR);
    const { instanceId } = await deployAndStart(db, modelFile, {
      processName: `T17_Linear_${runId}`,
    });

    await client.processUntilComplete(instanceId, {
      onWorkItem: async (item) => {
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
        await client.completeWorkItem(item.instanceId, item.payload.workItemId);
      },
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
    });

    await client.processUntilComplete(instanceId, {
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
