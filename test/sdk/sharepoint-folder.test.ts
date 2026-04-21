/**
 * SDK integration test: SharePoint folder trigger.
 * Mocks the Graph delta API and exercises the full flow — deploy → schedule
 * row created → initial poll primes cursor → subsequent polls emit
 * StartRequests per new matching file → idempotency on retry → delta token
 * expired recovery.
 */
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
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
import type { DriveItem } from '../../src/triggers/sharepoint-folder';
import { DeltaExpiredError } from '../../src/triggers/sharepoint-folder/graph-client';

// ── Mock the SharePoint Graph module ─────────────────────────────────────────

jest.mock('../../src/triggers/sharepoint-folder/graph-client', () => {
  const actual = jest.requireActual('../../src/triggers/sharepoint-folder/graph-client');
  return {
    ...actual,
    resolveSiteAndDrive: jest.fn(),
    deltaRequest: jest.fn(),
  };
});

const { resolveSiteAndDrive, deltaRequest } = jest.requireMock(
  '../../src/triggers/sharepoint-folder/graph-client',
) as {
  resolveSiteAndDrive: jest.Mock;
  deltaRequest: jest.Mock;
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
  resolveSiteAndDrive.mockReset().mockResolvedValue({ siteId: 'site-1', driveId: 'drive-1' });
  deltaRequest.mockReset();
});

function makeFile(overrides: Partial<DriveItem> = {}): DriveItem {
  const now = new Date().toISOString();
  const id = overrides.id ?? uuidv4();
  return {
    id,
    name: 'order.pdf',
    eTag: '"etag-v1"',
    size: 12_345,
    webUrl: `https://contoso.sharepoint.com/sites/Operations/Documents/Incoming/Orders/${overrides.name ?? 'order.pdf'}`,
    createdDateTime: now,
    lastModifiedDateTime: now,
    parentReference: { path: '/drives/drive-1/root:/Incoming/Orders' },
    file: { mimeType: 'application/pdf', hashes: { quickXorHash: 'abc' } },
    ...overrides,
  };
}

async function deploySharePointProcess(): Promise<string> {
  const bpmnXml = loadBpmn('sharepoint-folder-start.bpmn');
  const { definitionId } = await client.deploy({
    id: 'sp-folder',
    name: 'SharePoint Folder',
    version: '1',
    bpmnXml,
  });
  const schedules = await client.listConnectorSchedules({ definitionId });
  if (schedules.length > 0) {
    await client.resumeConnectorSchedule(schedules[0]._id);
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

describe('SharePoint folder trigger', () => {
  it('deploy creates a PAUSED TriggerSchedule row with tri:* config', async () => {
    const bpmnXml = loadBpmn('sharepoint-folder-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'sp-folder',
      name: 'SP',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listConnectorSchedules({ definitionId });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].triggerType).toBe('sharepoint-folder');
    expect(schedules[0].status).toBe('PAUSED');
    expect(schedules[0].initialPolicy).toBe('skip-existing');
    expect(schedules[0].config.siteUrl).toBe('https://contoso.sharepoint.com/sites/Operations');
    expect(schedules[0].config.folderPath).toBe('/Incoming/Orders');
    expect(schedules[0].config.fileNamePattern).toBe('*.pdf');
  });

  it('first poll with skip-existing primes cursor without emitting starts', async () => {
    const definitionId = await deploySharePointProcess();
    deltaRequest.mockResolvedValueOnce({
      items: [makeFile({ name: 'existing.pdf' })],
      deltaLink: 'https://graph/delta?token=abc',
    });

    const fired = await fire();
    expect(fired).toBe(true);

    const { ProcessInstances, TriggerSchedules } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);

    const row = await TriggerSchedules.findOne({ definitionId });
    expect(row?.cursor).toBe(JSON.stringify({ deltaLink: 'https://graph/delta?token=abc' }));
  });

  it('subsequent poll emits one StartRequest per new matching file', async () => {
    const definitionId = await deploySharePointProcess();

    // First poll: prime cursor.
    deltaRequest.mockResolvedValueOnce({
      items: [],
      deltaLink: 'https://graph/delta?token=1',
    });
    await fire();

    // Second poll: new file arrives.
    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    deltaRequest.mockResolvedValueOnce({
      items: [makeFile({ id: 'item-A', name: 'new-order.pdf' })],
      deltaLink: 'https://graph/delta?token=2',
    });
    await fire();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].idempotencyKey).toMatch(/^.+:item-A@/);
  });

  it('pattern filter excludes files that do not match', async () => {
    const definitionId = await deploySharePointProcess();

    deltaRequest.mockResolvedValueOnce({ items: [], deltaLink: 'https://graph/delta?token=1' });
    await fire();

    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    deltaRequest.mockResolvedValueOnce({
      items: [
        makeFile({ id: 'A', name: 'doc.txt' }),
        makeFile({ id: 'B', name: 'order.pdf' }),
      ],
      deltaLink: 'https://graph/delta?token=2',
    });
    await fire();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].idempotencyKey).toMatch(/:B@/);
  });

  it('skips items with size 0 (partial upload)', async () => {
    const definitionId = await deploySharePointProcess();
    deltaRequest.mockResolvedValueOnce({ items: [], deltaLink: 'https://graph/delta?token=1' });
    await fire();

    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    deltaRequest.mockResolvedValueOnce({
      items: [makeFile({ id: 'partial', size: 0 })],
      deltaLink: 'https://graph/delta?token=2',
    });
    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);
  });

  it('skips deleted items', async () => {
    const definitionId = await deploySharePointProcess();
    deltaRequest.mockResolvedValueOnce({ items: [], deltaLink: 'https://graph/delta?token=1' });
    await fire();

    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    deltaRequest.mockResolvedValueOnce({
      items: [{ id: 'gone', name: 'ghost.pdf', deleted: { state: 'deleted' } } as DriveItem],
      deltaLink: 'https://graph/delta?token=2',
    });
    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);
  });

  it('dedupe: same (itemId, eTag) across re-fires collapses to one instance', async () => {
    const definitionId = await deploySharePointProcess();

    deltaRequest.mockResolvedValueOnce({ items: [], deltaLink: 'https://graph/delta?token=1' });
    await fire();

    const { TriggerSchedules } = getCollections(db);
    // Simulate two consecutive fires that return the same item (e.g. a
    // network flake caused the scheduler to re-fire before cursor advanced).
    const item = makeFile({ id: 'same-item' });
    deltaRequest.mockResolvedValueOnce({ items: [item], deltaLink: 'https://graph/delta?token=2' });
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    await fire();

    deltaRequest.mockResolvedValueOnce({ items: [item], deltaLink: 'https://graph/delta?token=3' });
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(1);
  });

  it('DeltaExpiredError resets cursor by priming and emits no starts', async () => {
    const definitionId = await deploySharePointProcess();

    deltaRequest.mockResolvedValueOnce({ items: [], deltaLink: 'https://graph/delta?token=1' });
    await fire();

    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });

    // Next call: the stored cursor triggers a 410 → trigger should fall
    // back to a fresh delta (no starts) and persist the new deltaLink.
    deltaRequest
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        items: [makeFile({ id: 'should-be-skipped' })],
        deltaLink: 'https://graph/delta?token=fresh',
      });

    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);

    const row = await TriggerSchedules.findOne({ definitionId });
    expect(row?.cursor).toBe(JSON.stringify({ deltaLink: 'https://graph/delta?token=fresh' }));
  });

  it('validate() rejects invalid config at deploy time', async () => {
    const bpmnXml = `<?xml version="1.0"?>
      <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
        xmlns:tri="http://tri.com/schema/bpmn" id="Defs" targetNamespace="http://example.com/bpmn">
        <bpmn:message id="Msg" name="m"
          tri:connectorType="sharepoint-folder"
          tri:siteUrl="https://ok.com/sites/x"
          tri:folderPath="/Bad"
          tri:pollIntervalSeconds="5" />
        <bpmn:process id="P" isExecutable="true">
          <bpmn:startEvent id="Start"><bpmn:messageEventDefinition messageRef="Msg"/></bpmn:startEvent>
          <bpmn:endEvent id="End"/>
          <bpmn:sequenceFlow id="F" sourceRef="Start" targetRef="End"/>
        </bpmn:process>
      </bpmn:definitions>`;

    await expect(
      client.deploy({ id: 'sp-invalid', name: 'Bad', version: '1', bpmnXml }),
    ).rejects.toThrow(/pollIntervalSeconds/);
  });
});
