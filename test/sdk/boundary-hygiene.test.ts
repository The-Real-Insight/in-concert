/**
 * SDK boundary hygiene: the three new methods hosts can use instead of
 * reaching into in-concert's Mongo collections directly.
 *
 *   - client.getTriggerSchedule(scheduleId) — one row by public id
 *   - client.listTriggerSchedules({ startingTenantId }) — tenant filter
 *   - client.setInstanceMetadata(instanceId, { conversationId, tenantId })
 *     — write conversationId / tenantId on an existing ProcessInstance
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections, type TriggerScheduleDoc } from '../../src/db/collections';
import { BpmnEngineClient } from '../../src/sdk/client';

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

async function insertSchedule(overrides: Partial<TriggerScheduleDoc> = {}): Promise<TriggerScheduleDoc> {
  const { TriggerSchedules } = getCollections(db);
  const now = new Date();
  const doc: TriggerScheduleDoc = {
    _id: uuidv4(),
    scheduleId: uuidv4(),
    definitionId: uuidv4(),
    startEventId: 'Start_1',
    triggerType: 'fake',
    config: {},
    cursor: null,
    credentials: null,
    initialPolicy: 'fire-existing',
    status: 'ACTIVE',
    nextFireAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await TriggerSchedules.insertOne(doc);
  return doc;
}

describe('getTriggerSchedule', () => {
  it('returns the row matched by public scheduleId', async () => {
    const inserted = await insertSchedule({
      startingTenantId: 'tenant-x',
      config: { mailbox: 'x@example.com' },
    });
    const found = await client.getTriggerSchedule(inserted.scheduleId);
    expect(found).not.toBeNull();
    expect(found!.scheduleId).toBe(inserted.scheduleId);
    expect(found!.startingTenantId).toBe('tenant-x');
    expect(found!.config.mailbox).toBe('x@example.com');
  });

  it('falls back to _id match when scheduleId != _id lookup misses', async () => {
    // Simulate a legacy row where the caller passes the Mongo _id instead
    // of the public scheduleId. The SDK tolerates both.
    const inserted = await insertSchedule();
    const found = await client.getTriggerSchedule(inserted._id);
    expect(found).not.toBeNull();
    expect(found!._id).toBe(inserted._id);
  });

  it('returns null for unknown id', async () => {
    expect(await client.getTriggerSchedule('nonexistent')).toBeNull();
  });
});

describe('listTriggerSchedules startingTenantId filter', () => {
  it('returns only rows matching the given tenant', async () => {
    await insertSchedule({ startingTenantId: 'tenant-a' });
    await insertSchedule({ startingTenantId: 'tenant-a' });
    await insertSchedule({ startingTenantId: 'tenant-b' });
    await insertSchedule(); // no startingTenantId

    const tenantA = await client.listTriggerSchedules({ startingTenantId: 'tenant-a' });
    expect(tenantA).toHaveLength(2);
    expect(tenantA.every((s) => s.startingTenantId === 'tenant-a')).toBe(true);

    const tenantB = await client.listTriggerSchedules({ startingTenantId: 'tenant-b' });
    expect(tenantB).toHaveLength(1);

    // Without the filter: all four.
    const all = await client.listTriggerSchedules();
    expect(all).toHaveLength(4);
  });
});

describe('setInstanceMetadata', () => {
  async function insertInstance(): Promise<string> {
    const bpmnXml = loadBpmn('start-service-task-end.bpmn');
    const { definitionId } = await client.deploy({
      id: `meta-${uuidv4().slice(0, 8)}`,
      name: 'Metadata Test',
      version: '1',
      bpmnXml,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
    });
    return instanceId;
  }

  it('writes conversationId and tenantId on an existing instance', async () => {
    const instanceId = await insertInstance();
    const ok = await client.setInstanceMetadata(instanceId, {
      conversationId: 'conv-abc',
      tenantId: 'tenant-x',
    });
    expect(ok).toBe(true);

    const { ProcessInstances } = getCollections(db);
    const row = await ProcessInstances.findOne({ _id: instanceId } as any);
    expect((row as any)?.conversationId).toBe('conv-abc');
    expect((row as any)?.tenantId).toBe('tenant-x');
  });

  it('is a no-op when both fields are omitted', async () => {
    const instanceId = await insertInstance();
    const ok = await client.setInstanceMetadata(instanceId, {});
    expect(ok).toBe(true);
  });

  it('preserves unspecified fields — only writes what the host passed', async () => {
    const instanceId = await insertInstance();
    await client.setInstanceMetadata(instanceId, { tenantId: 'tenant-y' });
    await client.setInstanceMetadata(instanceId, { conversationId: 'conv-xyz' });

    const { ProcessInstances } = getCollections(db);
    const row = await ProcessInstances.findOne({ _id: instanceId } as any);
    expect((row as any)?.tenantId).toBe('tenant-y'); // kept from first call
    expect((row as any)?.conversationId).toBe('conv-xyz');
  });

  it('returns false when the instance does not exist', async () => {
    const ok = await client.setInstanceMetadata('no-such-instance', { tenantId: 't' });
    expect(ok).toBe(false);
  });
});

describe('instance synopsis', () => {
  async function insertInstance(): Promise<string> {
    const bpmnXml = loadBpmn('start-service-task-end.bpmn');
    const { definitionId } = await client.deploy({
      id: `synopsis-${uuidv4().slice(0, 8)}`,
      name: 'Synopsis Test',
      version: '1',
      bpmnXml,
    });
    const { instanceId } = await client.startInstance({
      commandId: uuidv4(),
      definitionId,
    });
    return instanceId;
  }

  it('returns null when no synopsis has been set', async () => {
    const instanceId = await insertInstance();
    const synopsis = await client.getInstanceSynopsis(instanceId);
    expect(synopsis).toBeNull();
  });

  it('round-trips text + source through setInstanceSynopsis / getInstanceSynopsis', async () => {
    const instanceId = await insertInstance();
    const ok = await client.setInstanceSynopsis(
      instanceId,
      'von Lisa Palfinger zu Glasscherben in Raum X',
      { source: 'auto' }
    );
    expect(ok).toBe(true);

    const synopsis = await client.getInstanceSynopsis(instanceId);
    expect(synopsis?.text).toBe('von Lisa Palfinger zu Glasscherben in Raum X');
    expect(synopsis?.source).toBe('auto');
    expect(synopsis?.updatedAt).toBeInstanceOf(Date);
  });

  it('records source = manual when a user pins a synopsis', async () => {
    const instanceId = await insertInstance();
    await client.setInstanceSynopsis(instanceId, 'auto-generated', { source: 'auto' });
    await client.setInstanceSynopsis(instanceId, 'manually pinned', { source: 'manual' });

    const synopsis = await client.getInstanceSynopsis(instanceId);
    expect(synopsis?.text).toBe('manually pinned');
    expect(synopsis?.source).toBe('manual');
  });

  it('rejects empty text', async () => {
    const instanceId = await insertInstance();
    await expect(
      client.setInstanceSynopsis(instanceId, '', { source: 'auto' })
    ).rejects.toThrow(/non-empty/);
  });

  it('rejects text exceeding the platform ceiling', async () => {
    const instanceId = await insertInstance();
    const tooLong = 'x'.repeat(201);
    await expect(
      client.setInstanceSynopsis(instanceId, tooLong, { source: 'auto' })
    ).rejects.toThrow(/ceiling/);
  });

  it('returns false when the instance does not exist', async () => {
    const ok = await client.setInstanceSynopsis('no-such-instance', 'hi', { source: 'auto' });
    expect(ok).toBe(false);
  });

  it('surfaces synopsis on getInstance summary once set', async () => {
    const instanceId = await insertInstance();
    await client.setInstanceSynopsis(instanceId, 'hello world', { source: 'auto' });

    const summary = await client.getInstance(instanceId);
    expect(summary?.instanceSynopsis).toBe('hello world');
    expect(summary?.instanceSynopsisSource).toBe('auto');
    expect(summary?.instanceSynopsisUpdatedAt).toBeInstanceOf(Date);
  });
});
