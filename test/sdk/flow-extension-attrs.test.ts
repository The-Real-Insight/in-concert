/**
 * Integration test: custom extension attributes on `<bpmn:sequenceFlow>`
 * reach the host's `onDecision` handler.
 *
 * Scenario: a BPMN author puts `acme:condition1` / `acme:condition2` /
 * `acme:explanation` on XOR-split flows and wants her handler to read
 * them to pick a branch — exactly the use case the engine's "extension
 * attributes flow through verbatim" promise is supposed to support.
 *
 * Before this change, the parser silently dropped any non-`condition`
 * extension attribute on sequence flows, so the handler saw only
 * `flowId`, `name`, `conditionExpression`, `isDefault`, and target
 * metadata — no `acme:*`.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import type { CallbackItem, DecisionTransition } from '../../src/sdk/types';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';

jest.setTimeout(15_000);

let db: Db;
let client: BpmnEngineClient;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
});

describe('custom extension attributes on sequence flows', () => {
  it('onDecision receives the full `acme:*` bag for each transition', async () => {
    const capturedTransitions: DecisionTransition[][] = [];

    client.init({
      onDecision: async (item: Extract<CallbackItem, { kind: 'CALLBACK_DECISION' }>) => {
        const transitions = item.payload.transitions;
        capturedTransitions.push(transitions);
        // Pick the default flow — the content of the decision doesn't
        // matter for this test; we only care that the bag came through.
        const defaultFlow = transitions.find((t) => t.isDefault);
        await client.submitDecision(item.instanceId, item.payload.decisionId, {
          selectedFlowIds: [defaultFlow!.flowId],
        });
      },
      onServiceCall: async () => {
        /* unused */
      },
    });
    client.startEngineWorker();

    try {
      const { definitionId } = await client.deploy({
        id: `flow-attrs-${uuidv4().slice(0, 8)}`,
        name: 'Flow Attrs',
        version: '1',
        bpmnXml: loadBpmn('xor-custom-flow-attrs.bpmn'),
      });
      const { instanceId } = await client.startInstance({ commandId: uuidv4(), definitionId });
      await client.run(instanceId);

      expect(capturedTransitions).toHaveLength(1);
      const transitions = capturedTransitions[0]!;
      const approve = transitions.find((t) => t.flowId === 'Flow_Approve');
      const reject = transitions.find((t) => t.flowId === 'Flow_Reject');

      // Approve carries three acme:* attrs verbatim.
      expect(approve?.attrs).toEqual({
        'acme:condition1': 'amount_below_threshold',
        'acme:condition2': 'customer_tier_premium',
        'acme:explanation': 'Small orders from premium customers are auto-approved',
      });

      // Reject carries one acme:* attr.
      expect(reject?.attrs).toEqual({
        'acme:explanation': 'Everything else goes to manual review',
      });
    } finally {
      await client.stopEngineWorker();
    }
  });

  it('transitions without extension attributes omit `attrs` entirely', async () => {
    let captured: DecisionTransition[] | null = null;

    client.init({
      onDecision: async (item: Extract<CallbackItem, { kind: 'CALLBACK_DECISION' }>) => {
        captured = item.payload.transitions;
        const defaultFlow = captured!.find((t) => t.isDefault);
        await client.submitDecision(item.instanceId, item.payload.decisionId, {
          selectedFlowIds: [defaultFlow!.flowId],
        });
      },
      onServiceCall: async () => {
        /* unused */
      },
    });
    client.startEngineWorker();

    try {
      // Use the existing plain XOR fixture — no acme:* attrs anywhere.
      const { definitionId } = await client.deploy({
        id: `plain-xor-${uuidv4().slice(0, 8)}`,
        name: 'Plain XOR',
        version: '1',
        bpmnXml: loadBpmn('xor-split-with-default.bpmn'),
      });
      const { instanceId } = await client.startInstance({ commandId: uuidv4(), definitionId });
      await client.run(instanceId);

      expect(captured).not.toBeNull();
      for (const t of captured!) {
        expect(t.attrs).toBeUndefined();
      }
    } finally {
      await client.stopEngineWorker();
    }
  });
});
