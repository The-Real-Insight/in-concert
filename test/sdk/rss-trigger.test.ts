/**
 * SDK integration test: RSS feed trigger.
 * Mocks the feed-client fetch and exercises the full flow — deploy → schedule
 * row created (ACTIVE) → initial poll primes cursor (skip-existing) →
 * subsequent polls create one instance per new item → idempotency on re-fire →
 * title-pattern filter → onFeedItemReceived hook (rawXml + skip).
 */
import type { Db } from 'mongodb';
import { BpmnEngineClient } from '../../src/sdk/client';
import { setupDb, teardownDb, loadBpmn } from '../scripts/helpers';
import { ensureIndexes } from '../../src/db/indexes';
import { getCollections } from '../../src/db/collections';
import { processOneTrigger } from '../../src/workers/trigger-scheduler';
import { getDefaultTriggerRegistry } from '../../src/triggers';
import type { RssFeed, RssFeedItem } from '../../src/triggers/rss/feed-client';

// ── Mock the feed-client (network) module ────────────────────────────────────

jest.mock('../../src/triggers/rss/feed-client', () => {
  const actual = jest.requireActual('../../src/triggers/rss/feed-client');
  return { ...actual, fetchFeed: jest.fn() };
});

const { fetchFeed } = jest.requireMock('../../src/triggers/rss/feed-client') as {
  fetchFeed: jest.Mock;
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
  fetchFeed.mockReset();
});

function makeItem(overrides: Partial<RssFeedItem> = {}): RssFeedItem {
  const guid = overrides.guid ?? 'guid-' + Math.random().toString(36).slice(2);
  return {
    guid,
    title: 'Breaking news',
    link: `https://example.com/${guid}`,
    pubDate: '2026-06-14T10:00:00.000Z',
    author: 'Reporter',
    content: '<p>Body</p>',
    contentSnippet: 'Body',
    categories: ['news'],
    categoryTerms: [{ term: 'news' }],
    enclosures: [],
    rawXml: `<item><guid>${guid}</guid><title>Breaking news</title></item>`,
    ...overrides,
  };
}

function feed(items: RssFeedItem[]): RssFeed {
  return { feedTitle: 'Example feed', items };
}

async function deployRssProcess(): Promise<string> {
  const bpmnXml = loadBpmn('rss-start.bpmn');
  const { definitionId } = await client.deploy({
    id: 'rss-feed',
    name: 'RSS Feed',
    version: '1',
    bpmnXml,
  });
  // RSS deploys ACTIVE; arm the interval so processOneTrigger claims it.
  const { TriggerSchedules } = getCollections(db);
  await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
  return definitionId;
}

async function rearm(definitionId: string): Promise<void> {
  const { TriggerSchedules } = getCollections(db);
  await TriggerSchedules.updateOne({ definitionId }, { $set: { lastFiredAt: new Date(0) } });
}

async function fire(): Promise<boolean> {
  return processOneTrigger(db, getDefaultTriggerRegistry());
}

describe('RSS feed trigger', () => {
  it('deploy creates an ACTIVE TriggerSchedule with tri:* config', async () => {
    const bpmnXml = loadBpmn('rss-start.bpmn');
    const { definitionId } = await client.deploy({
      id: 'rss-feed',
      name: 'RSS',
      version: '1',
      bpmnXml,
    });

    const schedules = await client.listTriggerSchedules({ definitionId });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].triggerType).toBe('rss');
    expect(schedules[0].status).toBe('ACTIVE');
    expect(schedules[0].initialPolicy).toBe('skip-existing');
    expect(schedules[0].config.feedUrl).toBe('https://example.com/feed.xml');
    expect(schedules[0].config.pollIntervalSeconds).toBe('300');
  });

  it('first poll with skip-existing primes cursor without creating instances', async () => {
    const definitionId = await deployRssProcess();
    fetchFeed.mockResolvedValueOnce(feed([makeItem({ guid: 'existing-1' })]));

    expect(await fire()).toBe(true);

    const { ProcessInstances, TriggerSchedules } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(0);
    const row = await TriggerSchedules.findOne({ definitionId });
    expect(row?.cursor).toBe('2026-06-14T10:00:00.000Z');
  });

  it('subsequent poll creates one instance per new item', async () => {
    const definitionId = await deployRssProcess();

    fetchFeed.mockResolvedValueOnce(feed([])); // prime
    await fire();

    await rearm(definitionId);
    fetchFeed.mockResolvedValueOnce(feed([makeItem({ guid: 'item-A' })]));
    await fire();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].idempotencyKey).toMatch(/:item-A$/);
  });

  it('dedupe: same guid across re-fires collapses to one instance', async () => {
    const definitionId = await deployRssProcess();
    fetchFeed.mockResolvedValueOnce(feed([])); // prime
    await fire();

    const item = makeItem({ guid: 'same' });
    await rearm(definitionId);
    fetchFeed.mockResolvedValueOnce(feed([item]));
    await fire();

    await rearm(definitionId);
    fetchFeed.mockResolvedValueOnce(feed([item]));
    await fire();

    const { ProcessInstances } = getCollections(db);
    expect(await ProcessInstances.countDocuments({ definitionId })).toBe(1);
  });

  it('titlePattern filter excludes non-matching items', async () => {
    const bpmnXml = `<?xml version="1.0"?>
      <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
        xmlns:tri="http://tri.com/schema/bpmn" id="Defs" targetNamespace="http://example.com/bpmn">
        <bpmn:message id="Msg" name="m"
          tri:connectorType="rss"
          tri:feedUrl="https://example.com/feed.xml"
          tri:titlePattern="^Alert:" />
        <bpmn:process id="P" isExecutable="true">
          <bpmn:startEvent id="Start"><bpmn:messageEventDefinition messageRef="Msg"/></bpmn:startEvent>
          <bpmn:endEvent id="End"/>
          <bpmn:sequenceFlow id="F" sourceRef="Start" targetRef="End"/>
        </bpmn:process>
      </bpmn:definitions>`;
    const { definitionId } = await client.deploy({ id: 'rss-filter', name: 'F', version: '1', bpmnXml });
    await rearm(definitionId);

    fetchFeed.mockResolvedValueOnce(feed([])); // prime
    await fire();

    await rearm(definitionId);
    fetchFeed.mockResolvedValueOnce(
      feed([
        makeItem({ guid: 'skip', title: 'Weather update' }),
        makeItem({ guid: 'keep', title: 'Alert: storm' }),
      ]),
    );
    await fire();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(1);
    expect(instances[0].idempotencyKey).toMatch(/:keep$/);
  });

  it('validate() rejects an invalid feedUrl at deploy time', async () => {
    const bpmnXml = `<?xml version="1.0"?>
      <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
        xmlns:tri="http://tri.com/schema/bpmn" id="Defs" targetNamespace="http://example.com/bpmn">
        <bpmn:message id="Msg" name="m" tri:connectorType="rss" tri:feedUrl="not-a-url" />
        <bpmn:process id="P" isExecutable="true">
          <bpmn:startEvent id="Start"><bpmn:messageEventDefinition messageRef="Msg"/></bpmn:startEvent>
          <bpmn:endEvent id="End"/>
          <bpmn:sequenceFlow id="F" sourceRef="Start" targetRef="End"/>
        </bpmn:process>
      </bpmn:definitions>`;
    await expect(
      client.deploy({ id: 'rss-bad', name: 'Bad', version: '1', bpmnXml }),
    ).rejects.toThrow(/feedUrl/);
  });

  it('validate() rejects a too-small pollIntervalSeconds', async () => {
    const bpmnXml = `<?xml version="1.0"?>
      <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
        xmlns:tri="http://tri.com/schema/bpmn" id="Defs" targetNamespace="http://example.com/bpmn">
        <bpmn:message id="Msg" name="m"
          tri:connectorType="rss"
          tri:feedUrl="https://example.com/feed.xml"
          tri:pollIntervalSeconds="5" />
        <bpmn:process id="P" isExecutable="true">
          <bpmn:startEvent id="Start"><bpmn:messageEventDefinition messageRef="Msg"/></bpmn:startEvent>
          <bpmn:endEvent id="End"/>
          <bpmn:sequenceFlow id="F" sourceRef="Start" targetRef="End"/>
        </bpmn:process>
      </bpmn:definitions>`;
    await expect(
      client.deploy({ id: 'rss-fast', name: 'Fast', version: '1', bpmnXml }),
    ).rejects.toThrow(/pollIntervalSeconds/);
  });

  it('extractEvents surfaces the rss trigger and its config', async () => {
    const bpmnXml = loadBpmn('rss-start.bpmn');
    const events = await client.extractEvents({ bpmnXml });
    expect(events).toHaveLength(1);
    expect(events[0].triggerType).toBe('rss');
    expect(events[0].config.feedUrl).toBe('https://example.com/feed.xml');
  });
});

describe('RSS feed trigger — onFeedItemReceived hook', () => {
  let rss: any;

  beforeEach(() => {
    rss = getDefaultTriggerRegistry().get('rss');
    expect(rss?.setOnFeedItemReceived).toBeDefined();
  });

  afterEach(() => {
    rss.setOnFeedItemReceived(null);
  });

  it('invokes the hook per new item with raw XML + parsed fields', async () => {
    const definitionId = await deployRssProcess();
    fetchFeed.mockResolvedValueOnce(feed([])); // prime
    await fire();

    const seen: any[] = [];
    rss.setOnFeedItemReceived(async (ev: any) => {
      seen.push({
        instanceId: ev.instanceId,
        guid: ev.item.guid,
        rawXml: ev.item.rawXml,
        feedTitle: ev.feedTitle,
      });
    });

    await rearm(definitionId);
    fetchFeed.mockResolvedValueOnce(
      feed([makeItem({ guid: 'a' }), makeItem({ guid: 'b' })]),
    );
    await fire();

    expect(seen).toHaveLength(2);
    expect(seen[0].instanceId).toBeTruthy();
    expect(seen[0].feedTitle).toBe('Example feed');
    expect(seen[0].rawXml).toContain('<item>');

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(2);
    for (const inst of instances) expect(inst.status).not.toBe('TERMINATED');
  });

  it('skip:true terminates the instance without running the process', async () => {
    const definitionId = await deployRssProcess();
    fetchFeed.mockResolvedValueOnce(feed([])); // prime
    await fire();

    rss.setOnFeedItemReceived(async (ev: any) =>
      ev.item.guid === 'drop' ? { skip: true } : undefined,
    );

    await rearm(definitionId);
    fetchFeed.mockResolvedValueOnce(
      feed([makeItem({ guid: 'keep' }), makeItem({ guid: 'drop' })]),
    );
    await fire();

    const { ProcessInstances } = getCollections(db);
    const instances = await ProcessInstances.find({ definitionId }).toArray();
    expect(instances).toHaveLength(2);
    const dropped = instances.find((i: any) => String(i.businessKey).includes('drop')) as any;
    const kept = instances.find((i: any) => String(i.businessKey).includes('keep')) as any;
    expect(dropped?.status).toBe('TERMINATED');
    expect(kept?.status).not.toBe('TERMINATED');
  });
});
