/**
 * SDK integration test: AI-listener trigger.
 * Mocks the tool + LLM HTTP calls and covers:
 *   - Deploy creates a PAUSED TriggerSchedule with triggerType='ai-listener'.
 *   - LLM "yes" fires one process instance.
 *   - LLM "no" fires nothing.
 *   - Unclear / ambiguous LLM output fires nothing.
 *   - Case-insensitive yes/no parsing.
 *   - Dedup: two "yes" fires with the same tool result → one instance
 *     (via fingerprint hash when no correlationId is supplied).
 *   - correlationId from LLM response overrides the hash-based dedup.
 *   - validate() rejects invalid deploys.
 */
import type { Db } from 'mongodb';
import { BpmnEngineClient } from '../../src/sdk/client';
import {
  setupDb,
  teardownDb,
  loadBpmn,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { processOneTrigger } from '../../src/workers/trigger-scheduler';
import { getDefaultTriggerRegistry } from '../../src/triggers';
import { AIListenerTrigger } from '../../src/triggers/ai-listener';
import { parseEvaluation } from '../../src/triggers/ai-listener/http';

// ── Mock the HTTP module ────────────────────────────────────────────────────

jest.mock('../../src/triggers/ai-listener/http', () => {
  const actual = jest.requireActual('../../src/triggers/ai-listener/http');
  return {
    ...actual,
    callTool: jest.fn(),
    evaluateWithLlm: jest.fn(),
  };
});

const { callTool, evaluateWithLlm } = jest.requireMock('../../src/triggers/ai-listener/http') as {
  callTool: jest.Mock;
  evaluateWithLlm: jest.Mock;
};

jest.setTimeout(20_000);

let db: Db;
let client: BpmnEngineClient;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  client.init({
    onServiceCall: async (item) => {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  callTool.mockReset();
  evaluateWithLlm.mockReset();

  // Ensure the trigger uses HTTP defaults (so our jest.mock actually bites).
  // Test-level `customEvaluate` / `customCallTool` remain null.
  const plugin = getDefaultTriggerRegistry().get('ai-listener');
  if (plugin instanceof AIListenerTrigger) {
    plugin.setCallTool(null);
    plugin.setEvaluate(null);
  }
});

async function deployAIListenerProcess(): Promise<string> {
  const bpmnXml = loadBpmn('ai-listener-start.bpmn');
  const { definitionId } = await client.deploy({
    id: 'ai-listener',
    name: 'AI Listener',
    version: '1',
    bpmnXml,
  });
  const schedules = await client.listConnectorSchedules({ definitionId });
  if (schedules.length > 0) {
    await client.resumeConnectorSchedule(schedules[0]._id);
    // Force it to be "due" immediately.
    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne(
      { _id: schedules[0]._id },
      { $set: { lastFiredAt: new Date(0) } },
    );
  }
  return definitionId;
}

async function fire(): Promise<boolean> {
  return processOneTrigger(db, getDefaultTriggerRegistry());
}

describe('AI-listener trigger', () => {
  it('deploy creates a PAUSED TriggerSchedule with the right config', async () => {
    const bpmnXml = loadBpmn('ai-listener-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'ai-deploy',
      name: 'AI',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listConnectorSchedules({ definitionId });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].triggerType).toBe('ai-listener');
    expect(schedules[0].status).toBe('PAUSED');
    expect(schedules[0].initialPolicy).toBe('skip-existing');
    expect(schedules[0].config.tool).toBe('get_weather');
    expect(schedules[0].config.prompt).toContain('raining');
  });

  it('LLM "yes" fires a process instance with rich payload', async () => {
    const definitionId = await deployAIListenerProcess();
    callTool.mockResolvedValueOnce({ tempC: 14, precipitation: 'light-rain' });
    evaluateWithLlm.mockResolvedValueOnce({
      decision: 'yes',
      reason: 'precipitation field indicates rain',
    });

    const fired = await fire();
    expect(fired).toBe(true);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].idempotencyKey).toMatch(/^.+:[a-f0-9]{16}$/);
  });

  it('LLM "no" fires no instance', async () => {
    const definitionId = await deployAIListenerProcess();
    callTool.mockResolvedValueOnce({ tempC: 22, precipitation: 'none' });
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'no' });

    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);
  });

  it('unclear / ambiguous LLM output fires no instance', async () => {
    const definitionId = await deployAIListenerProcess();
    callTool.mockResolvedValueOnce({ tempC: 18 });
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'unclear', reason: 'it depends' });

    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);
  });

  it('parseEvaluation handles common phrasings case-insensitively', () => {
    expect(parseEvaluation({ answer: 'YES' }).decision).toBe('yes');
    expect(parseEvaluation({ answer: 'yes, definitely' }).decision).toBe('yes');
    expect(parseEvaluation({ answer: 'No.' }).decision).toBe('no');
    expect(parseEvaluation({ answer: 'Maybe yes, maybe no' }).decision).toBe('unclear');
    expect(parseEvaluation({ decision: 'Yes', reason: 'because X' }).decision).toBe('yes');
    expect(parseEvaluation({ answer: 'The forecast is unclear' }).decision).toBe('unclear');
  });

  it('dedupes repeat yes-detections with the same tool result (hash fallback)', async () => {
    const definitionId = await deployAIListenerProcess();
    const sameResult = { tempC: 10, precipitation: 'heavy-rain' };

    // First fire: yes → creates an instance.
    callTool.mockResolvedValueOnce(sameResult);
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'yes' });
    await fire();

    // Second fire: same tool result, yes again → should dedupe.
    const { TriggerSchedules, ProcessInstances } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    callTool.mockResolvedValueOnce(sameResult);
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'yes' });
    await fire();

    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(1);
  });

  it('correlationId from the LLM response replaces the hash-based dedup', async () => {
    const definitionId = await deployAIListenerProcess();

    // First fire: the LLM says "yes" and names the event "zone-7-flood".
    callTool.mockResolvedValueOnce({ gauge: 4.2 });
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'yes', correlationId: 'zone-7-flood' });
    await fire();

    // Second fire: different tool result (gauge rising), same correlationId —
    // the detector decided it's still the SAME ongoing event. Should dedupe.
    const { TriggerSchedules, ProcessInstances } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    callTool.mockResolvedValueOnce({ gauge: 4.8 });
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'yes', correlationId: 'zone-7-flood' });
    await fire();

    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(1);

    // Third fire: new correlationId → distinct event → new instance.
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    callTool.mockResolvedValueOnce({ gauge: 5.5 });
    evaluateWithLlm.mockResolvedValueOnce({ decision: 'yes', correlationId: 'zone-8-flood' });
    await fire();

    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(2);
  });

  it('validate() rejects invalid configs at deploy time', async () => {
    // Missing toolEndpoint.
    const bad = loadBpmn('ai-listener-start.bpmn').replace(
      /tri:toolEndpoint="[^"]+"\s*/,
      '',
    );
    await expect(
      client.deploy({ id: 'ai-invalid', name: 'Bad', version: '1', bpmnXml: bad }),
    ).rejects.toThrow(/toolEndpoint/);
  });

  it('injected evaluator function bypasses HTTP entirely', async () => {
    // Swap in a pure-function evaluator — no network, no jest.mock needed.
    const plugin = getDefaultTriggerRegistry().get('ai-listener');
    if (!(plugin instanceof AIListenerTrigger)) throw new Error('unexpected plugin');

    plugin.setCallTool(async (_tool, _endpoint, _creds) => ({ stockPrice: 142.5, delta: 0.042 }));
    plugin.setEvaluate(async (_prompt, toolResult, _creds) => {
      const r = toolResult as { delta: number };
      return r.delta > 0.03
        ? { decision: 'yes', correlationId: 'daily-move' }
        : { decision: 'no' };
    });

    try {
      const definitionId = await deployAIListenerProcess();
      await fire();

      const { ProcessInstances } = getCollections(db);
      const instances = await ProcessInstances.find({ definitionId }).toArray();
      expect(instances).toHaveLength(1);
      expect(instances[0].idempotencyKey).toMatch(/:daily-move$/);

      // Since neither HTTP default ran, those mocks should be untouched.
      expect(callTool).not.toHaveBeenCalled();
      expect(evaluateWithLlm).not.toHaveBeenCalled();
    } finally {
      plugin.setCallTool(null);
      plugin.setEvaluate(null);
    }
  });
});
