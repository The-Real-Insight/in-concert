/**
 * RSS/Atom feed trigger. Polls a feed on an interval and starts one process
 * instance per new feed item. The item's GUID is the dedup key, so retries,
 * overlapping polls, and restarts collapse to a single instance per item.
 *
 * The plugin owns its config (the `tri:*` attributes on the BPMN) and its
 * credentials (per-schedule overrides via `TriggerSchedule.credentials`, for
 * private feeds). Engine core has no knowledge of RSS.
 *
 * Data ingestion mirrors graph-mailbox / sharepoint-folder: each new item
 * creates a `ProcessInstance` (deferred), then the host's `onFeedItemReceived`
 * callback runs with the instanceId + the raw item XML + parsed fields so the
 * host can stash the retrieved XML / seed data-pools, and finally the START
 * continuation is inserted (or the instance terminated on `{ skip: true }`).
 *
 * First-poll behavior: defaults to `skip-existing` — a fresh deploy primes the
 * cursor against the existing feed without flooding instances. Set
 * `tri:initialPolicy="fire-existing"` on the BPMN to process the backlog.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import {
  fetchFeed,
  extractRssCredentials,
  DEFAULT_RSS_POLLING_INTERVAL_MS,
  MIN_RSS_POLL_SECONDS,
  type RssCredentials,
  type RssFeedItem,
} from './feed-client';
import { startInstance, insertStartContinuation } from '../../instance/service';
import { getCollections } from '../../db/collections';
import { stripTriPrefix } from '../attrs';
import type {
  BpmnClaim,
  BpmnStartEventView,
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../types';

export const RSS_TRIGGER_TYPE = 'rss';

/**
 * Event handed to the host's `onFeedItemReceived` callback for every new feed
 * item, after the `ProcessInstance` is created but before BPMN execution
 * begins. The host can ingest the raw XML, seed data-pools, create a
 * conversation, or return `{ skip: true }` to terminate the instance without
 * running the process.
 */
export type FeedItemReceivedEvent = {
  /** Feed URL the schedule watches. */
  feedUrl: string;
  /** Feed-level title, when the feed provides one. */
  feedTitle: string;
  /** The process instance that was just created (still deferred). */
  instanceId: string;
  /** The process definition this instance belongs to. */
  definitionId: string;
  /** The feed item: parsed fields plus the raw <item>/<entry> XML. */
  item: RssFeedItem;
};

export type FeedItemReceivedResult = { skip?: boolean } | undefined | void;

export type OnFeedItemReceivedFn = (
  event: FeedItemReceivedEvent,
) => Promise<FeedItemReceivedResult>;

export class RssTrigger implements StartTrigger {
  readonly triggerType = RSS_TRIGGER_TYPE;
  // Don't flood a fresh deploy with the entire existing feed — same rationale
  // as sharepoint-folder.
  readonly defaultInitialPolicy = 'skip-existing' as const;
  // Public feeds need no credentials, so a schedule can start firing on deploy.
  // Private feeds can be paused/credentialed by the host afterwards.
  readonly deployStatus = 'ACTIVE' as const;

  private onFeedItemReceived: OnFeedItemReceivedFn | null = null;
  private readonly defaultPollingIntervalMs?: number;

  constructor(options?: {
    onFeedItemReceived?: OnFeedItemReceivedFn;
    defaultPollingIntervalMs?: number;
  }) {
    this.onFeedItemReceived = options?.onFeedItemReceived ?? null;
    this.defaultPollingIntervalMs = options?.defaultPollingIntervalMs;
  }

  /**
   * Resolve the default poll interval at call time: an explicit constructor
   * override wins, otherwise the `RSS_POLLING_INTERVAL_MS` env var (set by
   * `connectors.rss.pollingIntervalMs` at init), otherwise the built-in 5 min.
   */
  private resolveDefaultIntervalMs(): number {
    if (this.defaultPollingIntervalMs && this.defaultPollingIntervalMs > 0) {
      return this.defaultPollingIntervalMs;
    }
    const fromEnv = Number(process.env.RSS_POLLING_INTERVAL_MS);
    return Number.isFinite(fromEnv) && fromEnv > 0
      ? fromEnv
      : DEFAULT_RSS_POLLING_INTERVAL_MS;
  }

  /**
   * Configure the `onFeedItemReceived` hook after construction — used when the
   * engine's default registry already holds a trigger instance and the host
   * wires in its callback at init time.
   */
  setOnFeedItemReceived(fn: OnFeedItemReceivedFn | null): void {
    this.onFeedItemReceived = fn;
  }

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    // Accept tri:connectorType on the referenced <bpmn:message> (message start)
    // or inline on the start event — same flexibility as sharepoint-folder.
    const fromMessage = event.messageAttrs?.['tri:connectorType'];
    const fromSelf = event.selfAttrs['tri:connectorType'];
    const source =
      fromMessage === RSS_TRIGGER_TYPE
        ? event.messageAttrs!
        : fromSelf === RSS_TRIGGER_TYPE
        ? event.selfAttrs
        : null;
    if (!source) return null;
    return { config: stripTriPrefix(source, ['connectorType']) };
  }

  validate(def: TriggerDefinition): void {
    const feedUrl = def.config['feedUrl'];
    if (typeof feedUrl !== 'string' || !/^https?:\/\//.test(feedUrl)) {
      throw new Error('rss trigger requires tri:feedUrl (http/https URL)');
    }
    const rawInterval = def.config['pollIntervalSeconds'];
    if (rawInterval != null && rawInterval !== '') {
      const seconds = parseIntOrNaN(rawInterval);
      if (!Number.isFinite(seconds) || seconds < MIN_RSS_POLL_SECONDS) {
        throw new Error(
          `rss trigger tri:pollIntervalSeconds must be a number >= ${MIN_RSS_POLL_SECONDS} (got ${String(rawInterval)})`,
        );
      }
    }
    const titlePattern = def.config['titlePattern'];
    if (titlePattern != null && titlePattern !== '') {
      if (typeof titlePattern !== 'string') {
        throw new Error('rss trigger tri:titlePattern must be a string regex');
      }
      try {
        new RegExp(titlePattern);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`rss trigger tri:titlePattern is not a valid regex: ${detail}`);
      }
    }
  }

  nextSchedule(
    def: TriggerDefinition,
    _lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    const seconds = parseIntOrNaN(def.config['pollIntervalSeconds']);
    const ms =
      Number.isFinite(seconds) && seconds >= MIN_RSS_POLL_SECONDS
        ? seconds * 1000
        : this.resolveDefaultIntervalMs();
    return { kind: 'interval', ms };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    const cfg = invocation.definition.config;
    const feedUrl = String(cfg['feedUrl'] ?? '');
    if (!feedUrl) {
      throw new Error('rss trigger missing feedUrl in config');
    }
    const initialPolicy = String(cfg['initialPolicy'] ?? this.defaultInitialPolicy);

    const credentials: RssCredentials | undefined = extractRssCredentials(
      invocation.credentials,
    );

    const feed = await fetchFeed(feedUrl, { credentials });
    invocation.report?.observed(feed.items.length);

    // First poll with skip-existing primes the cursor without firing, so a
    // fresh deploy doesn't replay the whole feed.
    const isFirstPoll = invocation.cursor === null;
    if (isFirstPoll && initialPolicy === 'skip-existing') {
      return { starts: [], nextCursor: cursorFromItems(feed.items, invocation.cursor) };
    }

    // Optional title-regex filter (tri:titlePattern). Compiled once per fire.
    const rawPattern = cfg['titlePattern'];
    let titleRegex: RegExp | null = null;
    if (typeof rawPattern === 'string' && rawPattern.length > 0) {
      try {
        titleRegex = new RegExp(rawPattern);
      } catch {
        titleRegex = null;
      }
    }

    // Inline instance creation (mirror of graph-mailbox / sharepoint-folder):
    // we create each instance, invoke the host callback outside any Mongo
    // session, then insert the START continuation. Exactly-once is guarded by
    // the per-item idempotency key.
    const { ProcessInstances } = getCollections(invocation.db);

    for (const item of feed.items) {
      if (titleRegex && !titleRegex.test(item.title ?? '')) {
        invocation.report?.dropped('title-mismatch');
        continue;
      }

      const idempotencyKey = `${invocation.scheduleId}:${item.guid}`;
      const existing = await ProcessInstances.findOne(
        { definitionId: invocation.definition.definitionId, idempotencyKey },
        { projection: { _id: 1 } },
      );
      if (existing) {
        invocation.report?.dropped('already-processed');
        continue;
      }

      const commandId = uuidv4();
      const { instanceId } = await startInstance(invocation.db, {
        commandId,
        definitionId: invocation.definition.definitionId,
        businessKey: `rss:${item.guid}`,
        idempotencyKey,
        tenantId: invocation.startingTenantId,
        deferContinuation: true,
      });

      let skip = false;
      let callbackErr: unknown = null;
      if (this.onFeedItemReceived) {
        try {
          const r = await this.onFeedItemReceived({
            feedUrl,
            feedTitle: feed.feedTitle,
            instanceId,
            definitionId: invocation.definition.definitionId,
            item,
          });
          if (r?.skip) skip = true;
        } catch (err) {
          console.error(`[rss] onFeedItemReceived threw for ${item.guid}:`, err);
          skip = true;
          callbackErr = err;
        }
      }

      if (skip) {
        await terminateInstance(invocation.db, instanceId);
        if (callbackErr) {
          const msg = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
          const stack = callbackErr instanceof Error ? callbackErr.stack : undefined;
          invocation.report?.error({
            stage: 'callback',
            message: msg,
            rawSnippet: stack ? stack.slice(0, 500) : undefined,
          });
        } else {
          invocation.report?.dropped('callback-skip');
        }
      } else {
        await insertStartContinuation(invocation.db, { instanceId, commandId });
        invocation.report?.fired(instanceId);
      }
    }

    // Instances were created inline above; report no starts to the scheduler —
    // it only needs to advance the cursor.
    return { starts: [], nextCursor: cursorFromItems(feed.items, invocation.cursor) };
  }
}

async function terminateInstance(db: Db, instanceId: string): Promise<void> {
  const { ProcessInstances, ProcessInstanceState } = getCollections(db);
  const now = new Date();
  await ProcessInstances.updateOne(
    { _id: instanceId },
    { $set: { status: 'TERMINATED', endedAt: now } },
  );
  await ProcessInstanceState.updateOne(
    { _id: instanceId },
    { $set: { status: 'TERMINATED' } },
  );
}

/**
 * Cursor is the newest publication date seen so far (ISO string). Dedup is
 * enforced by the per-item idempotency key, so the cursor is purely an
 * optimization / first-poll marker; we keep the max of the prior cursor and
 * the newest item so it never moves backwards. Returns a non-null sentinel on
 * the first poll even for an empty feed, so `skip-existing` only applies once.
 */
function cursorFromItems(items: RssFeedItem[], prior: TriggerCursor): TriggerCursor {
  let newest = prior ?? '';
  for (const item of items) {
    if (item.pubDate && item.pubDate > newest) newest = item.pubDate;
  }
  return newest || 'primed';
}

function parseIntOrNaN(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return parseInt(v, 10);
  return NaN;
}
