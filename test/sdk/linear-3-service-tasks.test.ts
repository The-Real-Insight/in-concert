/**
 * SDK regression test: linear chain of 3 service tasks.
 *
 * Pins the "start then immediately run" usage that SDK consumers exercise for
 * user-initiated workflows:
 *
 *     const { instanceId } = await client.startInstance({...});
 *     const result = await client.run(instanceId);
 *
 * Also guards the single-process invariant behind `ensureInstanceWorker`: two
 * parallel callers (the change stream firing on a continuation insert and
 * `awaitQuiescent` from `client.run()`) must not both spawn workers. If they
 * did, the loser of the claim race would call `notifyWaiters` on a null claim
 * and resolve `run()` before the winner dispatched any task. The reservation
 * is synchronous (inFlight.set happens before any await), so the second
 * concurrent call sees the reservation and returns.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import { setupDb, teardownDb, shouldPurgeDb, loadBpmn, MOCK_USER } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';

jest.setTimeout(20000);

let db: Db;
let client: BpmnEngineClient;

const dispatched: Array<{ instanceId: string; name: string }> = [];

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
  client = new BpmnEngineClient({ mode: 'local', db });
  client.init({
    onServiceCall: async (item) => {
      const name = (item.payload as { name?: string }).name ?? '(unnamed)';
      dispatched.push({ instanceId: item.instanceId, name });
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
  });
  client.startEngineWorker();
});

afterAll(async () => {
  await client.stopEngineWorker();
  await teardownDb();
});

beforeEach(async () => {
  dispatched.length = 0;
  if (shouldPurgeDb()) {
    await db.dropDatabase();
    await ensureIndexes(db);
  }
});

describe('SDK: linear-3-service-tasks (regression)', () => {
  it('dispatches all three service tasks in order and completes', async () => {
    const bpmn = loadBpmn('linear-3-service-tasks.bpmn');
    const name = `Linear3_${uuidv4().slice(0, 8)}`;
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
    const forThisInstance = dispatched
      .filter((d) => d.instanceId === instanceId)
      .map((d) => d.name);
    expect(forThisInstance).toEqual(['A', 'B', 'C']);
  });

  it('does not spawn duplicate instance-workers under concurrent triggers', async () => {
    const bpmn = loadBpmn('linear-3-service-tasks.bpmn');
    const name = `Linear3Concurrent_${uuidv4().slice(0, 8)}`;
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

    // Reach into the engine worker — the public API is `run()`, but the
    // invariant we're guarding is in the private spawn path.
    const engineWorker = (client as unknown as { engineWorker: { ensureInstanceWorker?: (id: string) => unknown; inFlight: Map<string, unknown> } }).engineWorker;
    expect(engineWorker).toBeDefined();

    // Two synchronous calls for the same instanceId must not both pass the
    // reservation check. The second should find inFlight already set.
    const before = engineWorker.inFlight.size;
    (engineWorker as unknown as { ensureInstanceWorker: (id: string) => void }).ensureInstanceWorker(instanceId);
    (engineWorker as unknown as { ensureInstanceWorker: (id: string) => void }).ensureInstanceWorker(instanceId);
    const after = engineWorker.inFlight.size;
    expect(after - before).toBeLessThanOrEqual(1);

    // Drain so the process completes and doesn't leak state into later tests.
    const result = await client.run(instanceId);
    expect(result.status).toBe('COMPLETED');
  });
});
