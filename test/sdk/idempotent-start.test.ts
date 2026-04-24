/**
 * SDK integration test: idempotent startInstance.
 *
 * Verifies that two calls to `startInstance` with the same (definitionId,
 * idempotencyKey) pair return the same instance id and only one process
 * instance exists in Mongo. This is the exactly-once guarantee that
 * triggers rely on for their dedup keys.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { BpmnEngineClient } from '../../src/sdk/client';
import { startInstance } from '../../src/instance/service';
import { deployDefinition } from '../../src/model/service';

jest.setTimeout(15_000);

let db: Db;

beforeAll(async () => {
  db = await setupDb();
  await ensureIndexes(db);
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
});

describe('startInstance idempotency', () => {
  async function deploy(): Promise<string> {
    const { definitionId } = await deployDefinition(db, {
      id: `idem-${uuidv4().slice(0, 8)}`,
      name: 'Idempotency Test',
      version: '1',
      bpmnXml: loadBpmn('start-service-task-end.bpmn'),
    });
    return definitionId;
  }

  it('two calls with the same idempotencyKey return the same instanceId', async () => {
    const definitionId = await deploy();
    const key = `sched-123@2026-04-21T10:00:00.000Z`;

    const first = await startInstance(db, {
      commandId: uuidv4(),
      definitionId,
      idempotencyKey: key,
    });
    expect(first.deduplicated).toBeFalsy();

    const second = await startInstance(db, {
      commandId: uuidv4(),
      definitionId,
      idempotencyKey: key,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.instanceId).toBe(first.instanceId);

    const { ProcessInstances } = getCollections(db);
    const count = await ProcessInstances.countDocuments({ definitionId });
    expect(count).toBe(1);
  });

  it('different idempotencyKeys create separate instances', async () => {
    const definitionId = await deploy();

    const a = await startInstance(db, {
      commandId: uuidv4(),
      definitionId,
      idempotencyKey: 'key-A',
    });
    const b = await startInstance(db, {
      commandId: uuidv4(),
      definitionId,
      idempotencyKey: 'key-B',
    });
    expect(a.instanceId).not.toBe(b.instanceId);

    const { ProcessInstances } = getCollections(db);
    const count = await ProcessInstances.countDocuments({ definitionId });
    expect(count).toBe(2);
  });

  it('same key across different definitions does not collide', async () => {
    const defA = await deploy();
    const defB = await deploy();

    const a = await startInstance(db, {
      commandId: uuidv4(),
      definitionId: defA,
      idempotencyKey: 'same-key',
    });
    const b = await startInstance(db, {
      commandId: uuidv4(),
      definitionId: defB,
      idempotencyKey: 'same-key',
    });
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('calls without an idempotencyKey never dedupe', async () => {
    const definitionId = await deploy();

    const a = await startInstance(db, { commandId: uuidv4(), definitionId });
    const b = await startInstance(db, { commandId: uuidv4(), definitionId });
    expect(a.instanceId).not.toBe(b.instanceId);

    const { ProcessInstances } = getCollections(db);
    const count = await ProcessInstances.countDocuments({ definitionId });
    expect(count).toBe(2);
  });

  it('concurrent calls with the same key still produce one instance', async () => {
    const definitionId = await deploy();
    const key = 'concurrent-key';

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        startInstance(db, {
          commandId: uuidv4(),
          definitionId,
          idempotencyKey: key,
        }),
      ),
    );

    const uniqueIds = new Set(results.map((r) => r.instanceId));
    expect(uniqueIds.size).toBe(1);

    const { ProcessInstances } = getCollections(db);
    const count = await ProcessInstances.countDocuments({ definitionId });
    expect(count).toBe(1);
  });

  it('the deduped instance is fully usable (run completes normally)', async () => {
    const definitionId = await deploy();
    const client = new BpmnEngineClient({ mode: 'local', db });
    let serviceCalls = 0;
    client.init({
      onServiceCall: async (item) => {
        serviceCalls++;
        await client.completeExternalTask(item.instanceId, item.payload.workItemId);
      },
    });
    client.startEngineWorker();

    try {
      const first = await startInstance(db, {
        commandId: uuidv4(),
        definitionId,
        idempotencyKey: 'runnable',
      });
      const second = await startInstance(db, {
        commandId: uuidv4(),
        definitionId,
        idempotencyKey: 'runnable',
      });
      expect(second.instanceId).toBe(first.instanceId);

      const { status } = await client.run(first.instanceId);
      expect(status).toBe('COMPLETED');
      expect(serviceCalls).toBe(1);
    } finally {
      await client.stopEngineWorker();
    }
  });
});
