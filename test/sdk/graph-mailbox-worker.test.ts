/**
 * Integration test: Graph mailbox connector worker.
 * Mocks the Graph API (token, poll, attachments, mark-as-read) and tests the
 * full worker flow: poll → create instance → onMailReceived callback → run/skip.
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
import { processOneConnector, type OnMailReceivedFn } from '../../src/connectors/worker';
import type { MailReceivedEvent } from '../../src/sdk/types';
import type { GraphEmail } from '../../src/connectors/graph';

// ── Mock the Graph API module ────────────────────────────────────────────────

jest.mock('../../src/connectors/graph', () => ({
  pollMailbox: jest.fn(),
  markAsRead: jest.fn().mockResolvedValue(undefined),
  listAttachments: jest.fn(),
  getAttachmentContent: jest.fn(),
}));

const { pollMailbox, markAsRead, listAttachments, getAttachmentContent } =
  jest.requireMock('../../src/connectors/graph') as {
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
});

async function deployMailboxProcess(): Promise<string> {
  const bpmnXml = loadBpmn('graph-mailbox-start.bpmn');
  const { definitionId } = await client.deploy({
    id: 'graph-mailbox',
    name: 'Graph Mailbox',
    version: '1',
    bpmnXml,
  });
  return definitionId;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Graph mailbox connector worker', () => {
  it('polls and creates a process instance when an email arrives', async () => {
    const definitionId = await deployMailboxProcess();
    const email = makeEmail();
    pollMailbox.mockResolvedValueOnce([email]);

    const fired = await processOneConnector(db);
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
    const email = makeEmail({ subject: 'Important report' });
    pollMailbox.mockResolvedValueOnce([email]);

    const received: MailReceivedEvent[] = [];
    const handler: OnMailReceivedFn = async (event) => {
      received.push(event);
    };

    await processOneConnector(db, handler);

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

    const handler: OnMailReceivedFn = async () => ({ skip: true });

    await processOneConnector(db, handler);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('TERMINATED');

    // Email is still marked as read even when skipped
    expect(markAsRead).toHaveBeenCalled();
  });

  it('keeps instance RUNNING when onMailReceived returns skip: false', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail()]);

    const handler: OnMailReceivedFn = async () => ({ skip: false });

    await processOneConnector(db, handler);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('RUNNING');
  });

  it('terminates instance when onMailReceived throws', async () => {
    const definitionId = await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([makeEmail()]);

    const handler: OnMailReceivedFn = async () => {
      throw new Error('Handler crashed');
    };

    await processOneConnector(db, handler);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances[0].status).toBe('TERMINATED');
  });

  it('passes attachment metadata without downloading content', async () => {
    await deployMailboxProcess();
    const email = makeEmail({ hasAttachments: true });
    pollMailbox.mockResolvedValueOnce([email]);
    listAttachments.mockResolvedValueOnce([
      { id: 'att-1', name: 'report.pdf', contentType: 'application/pdf', size: 1_200_000 },
      { id: 'att-2', name: 'photo.jpg', contentType: 'image/jpeg', size: 450_000 },
    ]);

    const received: MailReceivedEvent[] = [];
    const handler: OnMailReceivedFn = async (event) => {
      received.push(event);
    };

    await processOneConnector(db, handler);

    expect(received[0].email.attachments).toHaveLength(2);
    expect(received[0].email.attachments[0].name).toBe('report.pdf');
    expect(received[0].email.attachments[0].size).toBe(1_200_000);
    expect(received[0].email.attachments[1].name).toBe('photo.jpg');

    // Content was NOT downloaded — getAttachmentContent not called
    expect(getAttachmentContent).not.toHaveBeenCalled();
  });

  it('getAttachmentContent downloads a single attachment on demand', async () => {
    await deployMailboxProcess();
    const email = makeEmail({ hasAttachments: true });
    pollMailbox.mockResolvedValueOnce([email]);
    listAttachments.mockResolvedValueOnce([
      { id: 'att-1', name: 'data.csv', contentType: 'text/csv', size: 500 },
    ]);
    getAttachmentContent.mockResolvedValueOnce(Buffer.from('col1,col2\na,b\n'));

    let downloadedBuffer: Buffer | null = null;
    const handler: OnMailReceivedFn = async (event) => {
      downloadedBuffer = await event.getAttachmentContent(event.email.attachments[0].id);
    };

    await processOneConnector(db, handler);

    expect(getAttachmentContent).toHaveBeenCalledWith(
      'ada@the-real-insight.com',
      'msg-001',
      'att-1',
      undefined, // no per-schedule credentials
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
    const handler: OnMailReceivedFn = async (event) => {
      subjects.push(event.email.subject);
    };

    await processOneConnector(db, handler);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(2);
    expect(subjects).toEqual(['First', 'Second']);
    expect(markAsRead).toHaveBeenCalledTimes(2);
  });

  it('does nothing when poll returns no emails', async () => {
    await deployMailboxProcess();
    pollMailbox.mockResolvedValueOnce([]);

    const handler: OnMailReceivedFn = jest.fn();

    await processOneConnector(db);

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({}).toArray();
    expect(instances).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns false when no connector schedules are active', async () => {
    // No deploy — no schedules exist
    const fired = await processOneConnector(db);
    expect(fired).toBe(false);
  });
});
