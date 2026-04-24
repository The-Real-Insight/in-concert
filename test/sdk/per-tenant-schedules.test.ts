/**
 * Per-tenant trigger schedules: one row per (definitionId, startEventId,
 * startingTenantId). Deploy writes only the owner's row; procurer tenants
 * get their own rows when they activate — cloned from the owner's config
 * and then overlaid with their configOverrides. Tenants run independently:
 * separate credentials, separate cursor, separate fire state.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { BpmnEngineClient } from '../../src/sdk/client';

jest.setTimeout(20_000);

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

async function deployAsOwner(ownerTenantId: string): Promise<string> {
  const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
  const { definitionId } = await client.deploy({
    id: `pt-${uuidv4().slice(0, 8)}`,
    name: 'Per-Tenant Schedules Test',
    version: '1',
    bpmnXml,
    tenantId: ownerTenantId,
  });
  return definitionId;
}

describe('Per-tenant trigger schedules', () => {
  it('deploy creates only the owner tenant row', async () => {
    const definitionId = await deployAsOwner('tenant-owner');
    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].startingTenantId).toBe('tenant-owner');
    // BPMN-authored mailbox preserved verbatim.
    expect(rows[0].config.mailbox).toBe('ada@the-real-insight.com');
  });

  it('procurer activate clones a new row; owner row is untouched', async () => {
    const definitionId = await deployAsOwner('tenant-owner');
    await client.activateSchedules(definitionId, {
      startingTenantId: 'tenant-proc',
      configOverrides: { mailbox: 'proc@example.com' },
    });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(2);
    const owner = rows.find((r) => r.startingTenantId === 'tenant-owner')!;
    const proc = rows.find((r) => r.startingTenantId === 'tenant-proc')!;

    // Procurer got their own row with a fresh id / scheduleId.
    expect(owner._id).not.toBe(proc._id);
    expect(owner.scheduleId).not.toBe(proc.scheduleId);
    // Procurer's override landed; owner's config is unchanged.
    expect(proc.config.mailbox).toBe('proc@example.com');
    expect(owner.config.mailbox).toBe('ada@the-real-insight.com');
    // Procurer starts fresh — no inherited credentials or cursor.
    expect(proc.credentials).toBeNull();
    expect(proc.cursor).toBeNull();
    // Procurer is ACTIVE (they just activated); owner wasn't touched.
    expect(proc.status).toBe('ACTIVE');
  });

  it('owner activate is a no-op clone (their row already exists)', async () => {
    const definitionId = await deployAsOwner('tenant-owner');
    await client.activateSchedules(definitionId, {
      startingTenantId: 'tenant-owner',
      graphCredentials: { tenantId: 'az-t', clientId: 'az-c', clientSecret: 'az-s' },
    });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(1); // still just the owner row
    expect(rows[0].startingTenantId).toBe('tenant-owner');
    expect(rows[0].status).toBe('ACTIVE');
    expect(rows[0].credentials).toEqual({ tenantId: 'az-t', clientId: 'az-c', clientSecret: 'az-s' });
  });

  it('deactivate is tenant-scoped: only the caller pauses', async () => {
    const definitionId = await deployAsOwner('tenant-owner');
    // Two tenants active.
    await client.activateSchedules(definitionId, { startingTenantId: 'tenant-owner' });
    await client.activateSchedules(definitionId, {
      startingTenantId: 'tenant-proc',
      configOverrides: { mailbox: 'proc@example.com' },
    });

    // Procurer pauses.
    await client.deactivateSchedules(definitionId, { startingTenantId: 'tenant-proc' });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(2);
    const owner = rows.find((r) => r.startingTenantId === 'tenant-owner')!;
    const proc = rows.find((r) => r.startingTenantId === 'tenant-proc')!;
    expect(owner.status).toBe('ACTIVE');
    expect(proc.status).toBe('PAUSED');
  });

  it('redeploy updates owner config, does NOT touch procurer row', async () => {
    const definitionId = await deployAsOwner('tenant-owner');
    await client.activateSchedules(definitionId, {
      startingTenantId: 'tenant-proc',
      configOverrides: { mailbox: 'proc@example.com' },
    });

    // Redeploy the same workflow (same id+version) with overwrite. The
    // owner's config.mailbox is reset to whatever the BPMN says. The
    // procurer's mailbox override must survive.
    const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
    await client.deploy({
      id: (await getCollections(db).ProcessDefinitions.findOne({ _id: definitionId }))!.id,
      name: 'Redeployed',
      version: '1',
      bpmnXml,
      overwrite: true,
      tenantId: 'tenant-owner',
    });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(2);
    const proc = rows.find((r) => r.startingTenantId === 'tenant-proc')!;
    expect(proc.config.mailbox).toBe('proc@example.com'); // untouched
    const owner = rows.find((r) => r.startingTenantId === 'tenant-owner')!;
    expect(owner.config.mailbox).toBe('ada@the-real-insight.com'); // BPMN default
  });

  it('configOverrides on existing procurer row update in place', async () => {
    const definitionId = await deployAsOwner('tenant-owner');
    await client.activateSchedules(definitionId, {
      startingTenantId: 'tenant-proc',
      configOverrides: { mailbox: 'first@example.com' },
    });
    await client.activateSchedules(definitionId, {
      startingTenantId: 'tenant-proc',
      configOverrides: { mailbox: 'second@example.com' },
    });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({
      definitionId,
      startingTenantId: 'tenant-proc',
    }).toArray();
    expect(rows).toHaveLength(1); // still one row, updated in place
    expect(rows[0].config.mailbox).toBe('second@example.com');
  });

  it('legacy (no startingTenantId) activate retains original bulk semantics', async () => {
    // Demo flow: deploy without tenantId, activate without tenantId. Everything
    // routes to the one existing row for this definition.
    const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
    const { definitionId } = await client.deploy({
      id: `pt-legacy-${uuidv4().slice(0, 8)}`,
      name: 'Legacy',
      version: '1',
      bpmnXml,
    });
    await client.activateSchedules(definitionId, {
      graphCredentials: { tenantId: 'az-t', clientId: 'az-c', clientSecret: 'az-s' },
    });

    const { TriggerSchedules } = getCollections(db);
    const rows = await TriggerSchedules.find({ definitionId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].startingTenantId).toBeUndefined();
    expect(rows[0].status).toBe('ACTIVE');
  });
});
