/**
 * RSS/Atom feed client for the `rss` start trigger.
 *
 * Fetches a feed over HTTP, parses it with `rss-parser` (RSS 2.0/1.0 + Atom),
 * and returns one {@link RssFeedItem} per entry. Each item carries both the
 * parsed fields the host commonly needs and the **raw XML** of the underlying
 * `<item>`/`<entry>` element, so the host can ingest the original markup
 * verbatim.
 *
 * This module is owned by the rss trigger plugin. Credentials (for private
 * feeds) come from the plugin via per-schedule storage. The engine core has
 * no knowledge of RSS.
 */
import { createHash } from 'crypto';
import Parser from 'rss-parser';

export const DEFAULT_RSS_POLLING_INTERVAL_MS = parseInt(
  process.env.RSS_POLLING_INTERVAL_MS ?? '300000', // 5 minutes
  10,
);

/** Minimum poll interval the trigger accepts, in seconds. */
export const MIN_RSS_POLL_SECONDS = 60;

// ── Credentials (optional — public feeds need none) ──────────────────────────

/**
 * Per-schedule authentication for private feeds. Stored verbatim on
 * `TriggerSchedule.credentials` via `setTriggerCredentials` and handed back to
 * the trigger at fire time.
 */
export type RssCredentials =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'header'; name: string; value: string };

/**
 * Coerce a stored credential bag (arbitrary JSON) into {@link RssCredentials}.
 * Returns undefined for public feeds (no/empty credentials).
 */
export function extractRssCredentials(
  creds: Record<string, unknown> | null,
): RssCredentials | undefined {
  if (!creds) return undefined;
  const kind = typeof creds.kind === 'string' ? creds.kind : undefined;
  if (kind === 'basic') {
    const username = String(creds.username ?? '');
    const password = String(creds.password ?? '');
    if (!username) return undefined;
    return { kind: 'basic', username, password };
  }
  if (kind === 'bearer') {
    const token = String(creds.token ?? '');
    if (!token) return undefined;
    return { kind: 'bearer', token };
  }
  if (kind === 'header') {
    const name = String(creds.name ?? '');
    const value = String(creds.value ?? '');
    if (!name) return undefined;
    return { kind: 'header', name, value };
  }
  return undefined;
}

function authHeaders(credentials?: RssCredentials): Record<string, string> {
  if (!credentials) return {};
  switch (credentials.kind) {
    case 'basic': {
      const token = Buffer.from(
        `${credentials.username}:${credentials.password}`,
      ).toString('base64');
      return { Authorization: `Basic ${token}` };
    }
    case 'bearer':
      return { Authorization: `Bearer ${credentials.token}` };
    case 'header':
      return { [credentials.name]: credentials.value };
  }
}

// ── Feed item shape ──────────────────────────────────────────────────────────

export type RssEnclosure = {
  url: string;
  type?: string;
  length?: number;
};

export type RssFeedItem = {
  /** Stable id: feed guid/atom id, else link, else a content hash. */
  guid: string;
  title: string;
  link: string;
  /** Publication date as ISO string, or null when the feed omits one. */
  pubDate: string | null;
  author: string;
  /** Full content (content:encoded / atom content), HTML if the feed sends it. */
  content: string;
  /** Plain-text snippet derived by the parser. */
  contentSnippet: string;
  categories: string[];
  enclosures: RssEnclosure[];
  /** Raw XML of the underlying <item>/<entry> element, verbatim from the feed. */
  rawXml: string;
};

export type RssFeed = {
  feedTitle: string;
  items: RssFeedItem[];
};

// ── Fetch + parse ────────────────────────────────────────────────────────────

const parser: Parser = new Parser();

/**
 * Fetch and parse a feed. Throws on network/parse errors so the scheduler
 * records the failure on the schedule row and retries next interval.
 */
export async function fetchFeed(
  feedUrl: string,
  options?: { credentials?: RssCredentials },
): Promise<RssFeed> {
  const res = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'in-concert-rss/1.0',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      ...authHeaders(options?.credentials),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RSS fetch failed (${res.status}) for ${feedUrl}: ${text.slice(0, 200)}`);
  }
  const xml = await res.text();
  const parsed = await parser.parseString(xml);

  const rawBlocks = extractItemBlocks(xml);
  const items: RssFeedItem[] = (parsed.items ?? []).map((item, index) =>
    toFeedItem(item, rawBlocks[index] ?? ''),
  );

  return { feedTitle: parsed.title ?? '', items };
}

function toFeedItem(item: Record<string, unknown>, rawXml: string): RssFeedItem {
  const link = asStr(item.link);
  const pubDate = asStr(item.isoDate) || asStr(item.pubDate) || '';
  const title = asStr(item.title);
  const guidSource =
    asStr(item.guid) || asStr(item.id) || link || hash(`${title}|${pubDate}|${rawXml}`);

  const enc = item.enclosure as { url?: string; type?: string; length?: string } | undefined;
  const enclosures: RssEnclosure[] = enc?.url
    ? [{ url: enc.url, type: enc.type, length: enc.length ? Number(enc.length) : undefined }]
    : [];

  const categories = Array.isArray(item.categories)
    ? (item.categories as unknown[]).map((c) => String(c))
    : [];

  return {
    guid: guidSource,
    title,
    link,
    pubDate: pubDate || null,
    author: asStr(item.creator) || asStr(item.author) || '',
    content: asStr(item['content:encoded']) || asStr(item.content) || '',
    contentSnippet: asStr(item.contentSnippet),
    categories,
    enclosures,
    rawXml,
  };
}

/**
 * Slice the source XML into the raw markup of each `<item>` (RSS) or
 * `<entry>` (Atom) element, in document order. `rss-parser` preserves entry
 * order, so the Nth block aligns with the Nth parsed item. Best-effort: a feed
 * embedding a literal `</item>` inside un-escaped CDATA could mis-slice, but
 * that is vanishingly rare and only affects the `rawXml` fidelity of that one
 * item — parsed fields are unaffected.
 */
export function extractItemBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[0]);
  }
  return blocks;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
