/**
 * SDK test: Graph mailbox message start event.
 * Verifies that deploying a BPMN with a message start event + tri:connectorType
 * creates a ConnectorSchedule, and that pause/resume works.
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

jest.setTimeout(20000);

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

describe('Graph mailbox message start event', () => {
  it('deploy creates a ConnectorSchedule for graph-mailbox message start events', async () => {
    const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'graph-mailbox',
      name: 'Graph Mailbox',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listConnectorSchedules({ definitionId });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].connectorType).toBe('graph-mailbox');
    expect(schedules[0].config.mailbox).toBe('ada@the-real-insight.com');
    expect(schedules[0].status).toBe('ACTIVE');
  });

  it('redeploy replaces the connector schedule', async () => {
    const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
    await client.deploy({ id: 'graph-mailbox', name: 'Graph Mailbox', version: '1', bpmnXml });
    await client.deploy({ id: 'graph-mailbox', name: 'Graph Mailbox', version: '1', bpmnXml, overwrite: true });

    const schedules = await client.listConnectorSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].status).toBe('ACTIVE');
  });

  it('pause and resume a connector schedule', async () => {
    const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'graph-mailbox',
      name: 'Graph Mailbox',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listConnectorSchedules({ definitionId });
    const id = schedules[0]._id;

    await client.pauseConnectorSchedule(id);
    const paused = (await client.listConnectorSchedules({ definitionId }))[0];
    expect(paused.status).toBe('PAUSED');

    await client.resumeConnectorSchedule(id);
    const resumed = (await client.listConnectorSchedules({ definitionId }))[0];
    expect(resumed.status).toBe('ACTIVE');
  });

  it('parser extracts connectorConfig on the start event node', async () => {
    const { parseBpmnXml } = await import('../../src/model/parser');
    const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
    const graph = await parseBpmnXml(bpmnXml);

    const startNode = graph.nodes[graph.startNodeIds[0]];
    expect(startNode.messageRef).toBe('inbox-poll');
    expect(startNode.connectorConfig).toBeDefined();
    expect(startNode.connectorConfig!.connectorType).toBe('graph-mailbox');
    expect(startNode.connectorConfig!.mailbox).toBe('ada@the-real-insight.com');
  });

  it('deploying a process without connectors creates no connector schedule', async () => {
    const bpmnXml = loadBpmn('start-service-task-end.bpmn');
    const { definitionId } = await client.deploy({
      id: 'no-connector',
      name: 'No Connector',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listConnectorSchedules({ definitionId });
    expect(schedules).toHaveLength(0);
  });
});
