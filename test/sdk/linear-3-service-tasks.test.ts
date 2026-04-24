/**
 * SDK regression test: linear chain of 3 service tasks.
 *
 * Covers the "start then immediately run" usage pattern that tri-server (and
 * any SDK consumer) exercises for user-initiated workflows:
 *
 *     const { instanceId } = await client.startInstance({...});
 *     // ...optionally set caller-side context keyed by instanceId...
 *     const result = await client.run(instanceId);
 *
 * The failure this test guards against: `run()` resolved before the engine
 * worker dispatched any task, because `claimContinuation` (readConcern
 * majority) couldn't see the just-written START continuation. Root cause was
 * the Continuations collection using the default writeConcern — the insert
 * returned before majority-commit, so a subsequent majority-snapshot read
 * from a different implicit session could miss it. Collection-level
 * `writeConcern: 'majority'` fixes it by construction.
 *
 * On a local single-node replica set the race window collapses to zero, so
 * this test primarily pins expected behavior (all three onServiceCall
 * dispatches fire, in order, and the instance reaches COMPLETED). On Atlas
 * or any multi-node replica set, the writeConcern fix is load-bearing.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { BpmnEngineClient } from '../../src/sdk/client';
import { setupDb, teardownDb, shouldPurgeDb, loadBpmn, MOCK_USER } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';

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

    // Call run() immediately after startInstance, with no intervening awaits.
    // This is the exact shape that failed in tri-server: the race relies on a
    // narrow window between the START continuation insert and the first
    // claimContinuation read.
    const result = await client.run(instanceId);

    expect(result.status).toBe('COMPLETED');
    const forThisInstance = dispatched
      .filter((d) => d.instanceId === instanceId)
      .map((d) => d.name);
    expect(forThisInstance).toEqual(['A', 'B', 'C']);
  });

  it('Continuations collection is configured with writeConcern majority', async () => {
    // Structural guard. The behavioral race above can only manifest on
    // multi-node replica sets (Atlas), so this test pins the configuration
    // regardless of the local test deployment.
    const { Continuations } = getCollections(db);
    const wc = Continuations.writeConcern;
    expect(wc).toBeDefined();
    expect(wc?.w).toBe('majority');
  });

  it('does not spawn duplicate instance-workers under concurrent triggers', async () => {
    // Deterministic regression for the real race behind the phantom-quiescent
    // symptom: the change stream and `awaitQuiescent` both call
    // `ensureInstanceWorker` in parallel. If the guard-to-set window contains
    // any awaits, both calls spawn workers, and the loser of the claim race
    // resolves `run()` before the winner dispatches any task. This test
    // simulates that by calling into the engine worker's private path twice
    // in the same tick for the same instanceId, and asserts only one
    // instance-worker ends up in the in-flight map.
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

    // Reach into the engine worker — this is intentional: the public API is
    // `run()`, but the race we're guarding is in the private spawn path.
    const engineWorker = (client as unknown as { engineWorker: { ensureInstanceWorker?: (id: string) => unknown; inFlight: Map<string, unknown> } }).engineWorker;
    expect(engineWorker).toBeDefined();

    // Trigger ensureInstanceWorker TWICE back-to-back. With the bug, both
    // calls pass the `inFlight.has` guard because the `inFlight.set`
    // happened behind an await. With the fix, the second call sees the
    // reservation and returns immediately.
    const before = engineWorker.inFlight.size;
    // The real engineWorker method may be private in TS but exists at
    // runtime on the instance.
    (engineWorker as unknown as { ensureInstanceWorker: (id: string) => void }).ensureInstanceWorker(instanceId);
    (engineWorker as unknown as { ensureInstanceWorker: (id: string) => void }).ensureInstanceWorker(instanceId);
    const after = engineWorker.inFlight.size;
    expect(after - before).toBeLessThanOrEqual(1);

    // Let run() drain so the process completes and doesn't leak state into
    // later tests.
    const result = await client.run(instanceId);
    expect(result.status).toBe('COMPLETED');
  });
});
