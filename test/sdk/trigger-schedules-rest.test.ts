/**
 * SDK integration test: canonical trigger-schedules SDK surface.
 * Verifies that the new list/pause/resume methods touch TriggerSchedule
 * rows across all trigger types uniformly, while the legacy timer/
 * connector-schedule methods remain as filtered aliases.
 */
import type { Db } from 'mongodb';
import { BpmnEngineClient } from '../../src/sdk/client';
import {
  setupDb,
  teardownDb,
  loadBpmn,
} from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';

jest.setTimeout(15_000);

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
});

describe('canonical trigger schedules', () => {
  it('listTriggerSchedules returns both timer and connector schedules', async () => {
    await client.deploy({
      id: 'timer-test',
      name: 'T',
      version: '1',
      bpmnXml: loadBpmn('timer-start.bpmn'),
    });
    await client.deploy({
      id: 'mailbox-test',
      name: 'M',
      version: '1',
      bpmnXml: loadBpmn('graph-mailbox-start.bpmn'),
    });

    const all = await client.listTriggerSchedules();
    const types = all.map((s) => s.triggerType).sort();
    expect(types).toEqual(['graph-mailbox', 'timer']);
  });

  it('listTriggerSchedules can filter by triggerType', async () => {
    await client.deploy({
      id: 'timer-test',
      name: 'T',
      version: '1',
      bpmnXml: loadBpmn('timer-start.bpmn'),
    });
    await client.deploy({
      id: 'sp-test',
      name: 'SP',
      version: '1',
      bpmnXml: loadBpmn('sharepoint-folder-start.bpmn'),
    });

    const spOnly = await client.listTriggerSchedules({ triggerType: 'sharepoint-folder' });
    expect(spOnly).toHaveLength(1);
    expect(spOnly[0].triggerType).toBe('sharepoint-folder');
  });

  it('pauseTriggerSchedule / resumeTriggerSchedule work across trigger types', async () => {
    await client.deploy({
      id: 'timer-test',
      name: 'T',
      version: '1',
      bpmnXml: loadBpmn('timer-start.bpmn'),
    });
    const [timerSchedule] = await client.listTriggerSchedules({ triggerType: 'timer' });
    expect(timerSchedule.status).toBe('ACTIVE');

    await client.pauseTriggerSchedule(timerSchedule._id);
    const [pausedTimer] = await client.listTriggerSchedules({ triggerType: 'timer' });
    expect(pausedTimer.status).toBe('PAUSED');

    await client.resumeTriggerSchedule(timerSchedule._id);
    const [resumedTimer] = await client.listTriggerSchedules({ triggerType: 'timer' });
    expect(resumedTimer.status).toBe('ACTIVE');
  });

  it('setTriggerCredentials stores arbitrary credential shape', async () => {
    await client.deploy({
      id: 'sp-test',
      name: 'SP',
      version: '1',
      bpmnXml: loadBpmn('sharepoint-folder-start.bpmn'),
    });
    const [schedule] = await client.listTriggerSchedules({ triggerType: 'sharepoint-folder' });
    await client.setTriggerCredentials(schedule._id, {
      tenantId: 't-1',
      clientId: 'c-1',
      clientSecret: 's-1',
    });

    const [after] = await client.listTriggerSchedules({ triggerType: 'sharepoint-folder' });
    expect(after.credentials).toEqual({
      tenantId: 't-1',
      clientId: 'c-1',
      clientSecret: 's-1',
    });
  });

  it('legacy listTimerSchedules still works (filtered alias)', async () => {
    await client.deploy({
      id: 'timer-test',
      name: 'T',
      version: '1',
      bpmnXml: loadBpmn('timer-start.bpmn'),
    });
    await client.deploy({
      id: 'mailbox-test',
      name: 'M',
      version: '1',
      bpmnXml: loadBpmn('graph-mailbox-start.bpmn'),
    });

    const timers = await client.listTimerSchedules();
    expect(timers).toHaveLength(1);
    expect(timers[0].triggerType).toBe('timer');
  });

  it('legacy listConnectorSchedules returns non-timer triggers only', async () => {
    await client.deploy({
      id: 'timer-test',
      name: 'T',
      version: '1',
      bpmnXml: loadBpmn('timer-start.bpmn'),
    });
    await client.deploy({
      id: 'mailbox-test',
      name: 'M',
      version: '1',
      bpmnXml: loadBpmn('graph-mailbox-start.bpmn'),
    });
    await client.deploy({
      id: 'sp-test',
      name: 'SP',
      version: '1',
      bpmnXml: loadBpmn('sharepoint-folder-start.bpmn'),
    });

    const connectors = await client.listConnectorSchedules();
    const types = connectors.map((c) => c.triggerType).sort();
    expect(types).toEqual(['graph-mailbox', 'sharepoint-folder']);
  });
});
