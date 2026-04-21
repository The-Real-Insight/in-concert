/**
 * Integration test: Graph mailbox trigger.
 * Mocks the Graph API (token, poll, attachments, mark-as-read) and tests the
 * full trigger flow: poll → create instance → onMailReceived callback →
 * run/skip. Exercises the new `processOneTrigger` scheduler, not the old
 * dedicated connector worker.
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
import { GraphMailboxTrigger } from '../../src/triggers/graph-mailbox/graph-mailbox-trigger';
import type {
  GraphEmail,
  MailReceivedEvent,
  OnMailReceivedFn,
} from '../../src/triggers/graph-mailbox';

// ── Mock the Graph API module ────────────────────────────────────────────────

jest.mock('../../src/triggers/graph-mailbox/graph', () => ({
  pollMailbox: jest.fn(),
  markAsRead: jest.fn().mockResolvedValue(undefined),
  listAttachments: jest.fn(),
  getAttachmentContent: jest.fn(),
  DEFAULT_GRAPH_POLLING_INTERVAL_MS: 10_000,
  DEFAULT_GRAPH_SINCE_MINUTES: 1440,
}));

const { pollMailbox, markAsRead, listAttachments, getAttachmentContent } =
  jest.requireMock('../../src/triggers/graph-mailbox/graph') as {
    pollMailbox: jest.Mock;
    markAsRead: jest.Mock;
    listAttachments: jest.Mock;
    getAttachmentContent: jest.Mock;
  };

function makeEmail(overrides?: Partial<GraphEmail>): GraphEmail {
  return {
    id: 'msg-001',
    subject: 'Test email',
    from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Ada', address: 'ada@the-real-insight.com' } }],
    receivedDateTime: new Date().toISOString(),
    bodyPreview: 'Hello from the test',
    body: { contentType: 'text', content: 'Hello from the test' },
    hasAttachments: false,
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

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
  pollMailbox.mockReset();
  markAsRead.mockReset().mockResolvedValue(undefined);
  listAttachments.mockReset();
  getAttachmentContent.mockReset();

  // Reset the mailbox trigger's onMailReceived between tests.
  const mailbox = getDefaultTriggerRegistry().get('graph-mailbox');
  if (mailbox instanceof GraphMailboxTrigger) {
    mailbox.setOnMailReceived(null);
  }
});

function setOnMailReceived(handler: OnMailReceivedFn | null): void {
  const mailbox = getDefaultTriggerRegistry().get('graph-mailbox');
  if (!(mailbox instanceof GraphMailboxTrigger)) {
    throw new Error('graph-mailbox trigger not registered as expected');
  }
  mailbox.setOnMailReceived(handler);
}

async function deployMailboxProcess(): Promise<string> {
  const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
  const { definitionId } = await client.deploy({
    id: 'graph-mailbox',
    name: 'Graph Mailbox',
    version: '1',
    bpmnXml,
  });
  // Mailbox trigger schedules deploy as PAUSED — resume for tests.
  const schedules = await client.listConnectorSchedules({ definitionId });
  if (schedules.length > 0) {
    await client.resumeConnectorSchedule(schedules[0]._id);
    // Force it to be "due" right away so processOneTrigger picks it up.
    const { TriggerSchedules } = getCollections(db);
    await TriggerSchedules.updateOne(
      { _id: schedules[0]._id },
      { $set: { lastFiredAt: new Date(0) } },
    );
  }
  return definitionId;
}

async function fireMailbox(): Promise<boolean> {
  return processOneTrigger(db, getDefaultTriggerRegistry());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Graph mailbox trigger', () => {
  it('polls and creates a process instance when an email arrives', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail()]);

    const fired = await fireMailbox();
    expect(fired).toBe(true);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].businessKey).toBe('email:msg-001');
    expect(instances[0].status).toBe('RUNNING');

    expect(markAsRead).toHaveBeenCalledWith('ada@the-real-insight.com', 'msg-001', undefined);
  });

  it('calls onMailReceived with email data and instanceId', async () => {
    await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail({ subject: 'Important report' })]);

    const received: MailReceivedEvent[] = [];
    setOnMailReceived(async (event) => {
      received.push(event);
    });

    await fireMailbox();

    expect(received).toHaveLength(1);
    expect(received[0].mailbox).toBe('ada@the-real-insight.com');
    expect(received[0].email.subject).toBe('Important report');
    expect(received[0].email.from.address).toBe('alice@example.com');
    expect(received[0].instanceId).toBeDefined();
    expect(typeof received[0].getAttachmentContent).toBe('function');
  });

  it('terminates instance when onMailReceived returns skip: true', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail()]);

    setOnMailReceived(async () => ({ skip: true }));

    await fireMailbox();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('TERMINATED');

    expect(markAsRead).toHaveBeenCalled();
  });

  it('keeps instance RUNNING when onMailReceived returns skip: false', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail()]);

    setOnMailReceived(async () => ({ skip: false }));

    await fireMailbox();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('RUNNING');
  });

  it('terminates instance when onMailReceived throws', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail()]);

    setOnMailReceived(async () => {
      throw new Error('Handler crashed');
    });

    await fireMailbox();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances[0].status).toBe('TERMINATED');
  });

  it('passes attachment metadata without downloading content', async () => {
    await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail({ hasAttachments: true })]);
    listAttachments.mockResolvedValueOnce([
      { id: 'att-1', name: 'report.pdf', contentType: 'application/pdf', size: 1_200_000 },
      { id: 'att-2', name: 'photo.jpg', contentType: 'image/jpeg', size: 450_000 },
    ]);

    const received: MailReceivedEvent[] = [];
    setOnMailReceived(async (event) => {
      received.push(event);
    });

    await fireMailbox();

    expect(received[0].email.attachments).toHaveLength(2);
    expect(received[0].email.attachments[0].name).toBe('report.pdf');
    expect(received[0].email.attachments[0].size).toBe(1_200_000);
    expect(received[0].email.attachments[1].name).toBe('photo.jpg');

    expect(getAttachmentContent).not.toHaveBeenCalled();
  });

  it('getAttachmentContent downloads a single attachment on demand', async () => {
    await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail({ hasAttachments: true })]);
    listAttachments.mockResolvedValueOnce([
      { id: 'att-1', name: 'data.csv', contentType: 'text/csv', size: 500 },
    ]);
    getAttachmentContent.mockResolvedValueOnce(Buffer.from('col1,col2\na,b\n'));

    let downloadedBuffer: Buffer | null = null;
    setOnMailReceived(async (event) => {
      downloadedBuffer = await event.getAttachmentContent(event.email.attachments[0].id);
    });

    await fireMailbox();

    expect(getAttachmentContent).toHaveBeenCalledWith(
      'ada@the-real-insight.com',
      'msg-001',
      'att-1',
      undefined,
    );
    expect(downloadedBuffer).not.toBeNull();
    expect(downloadedBuffer!.toString()).toBe('col1,col2\na,b\n');
  });

  it('handles multiple emails in one poll cycle', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([
      makeEmail({ id: 'msg-001', subject: 'First' }),
      makeEmail({ id: 'msg-002', subject: 'Second', receivedDateTime: new Date(Date.now() + 1000).toISOString() }),
    ]);

    const subjects: string[] = [];
    setOnMailReceived(async (event) => {
      subjects.push(event.email.subject);
    });

    await fireMailbox();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(2);
    expect(subjects).toEqual(['First', 'Second']);
    expect(markAsRead).toHaveBeenCalledTimes(2);
  });

  it('does nothing when poll returns no emails', async () => {
    await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([]);

    const handler = jest.fn();
    setOnMailReceived(handler);

    await fireMailbox();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({}).toArray();
    expect(instances).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns false when no trigger schedules are active', async () => {
    const fired = await fireMailbox();
    expect(fired).toBe(false);
  });
});
