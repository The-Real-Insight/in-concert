/**
 * Unit tests for the rss feed-client parsing path.
 *
 * These drive `fetchFeed` against real `rss-parser` output (only the network
 * `fetch` is stubbed), because the bug this covers lived precisely in the seam
 * between rss-parser's output shape and our normalization: a `<category>` with
 * an attribute arrives as a null-prototype xml2js node, not a string.
 */
import { fetchFeed } from './feed-client';

function feedXml(itemBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test feed</title>
    <item>
      <title>Reinigung</title>
      <link>https://example.com/1</link>
      <guid>guid-1</guid>
      ${itemBody}
    </item>
  </channel>
</rss>`;
}

function stubFetch(xml: string): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => xml,
  }) as unknown as typeof fetch;
}

describe('fetchFeed category parsing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses bare categories as plain terms', async () => {
    stubFetch(feedXml('<category>90911200</category><category>open</category>'));
    const feed = await fetchFeed('https://example.com/rss');
    expect(feed.items[0].categories).toEqual(['90911200', 'open']);
    expect(feed.items[0].categoryTerms).toEqual([{ term: '90911200' }, { term: 'open' }]);
  });

  // Regression: rss-parser returns { _: 'DEF04', $: { domain: 'nutsCodes' } } for
  // an attribute-carrying category. That node has a null prototype, so String(c)
  // threw and killed the whole poll instead of yielding '[object Object]'.
  it('does not throw on a category carrying a domain attribute', async () => {
    stubFetch(feedXml('<category domain="nutsCodes">DEF04</category>'));
    await expect(fetchFeed('https://example.com/rss')).resolves.toBeDefined();
  });

  it('extracts the term and domain from an attribute-carrying category', async () => {
    stubFetch(
      feedXml(
        '<category domain="nutsCodes">DEF04</category>' +
          '<category domain="locations">Musterstraße 1, 24103 Kiel, DEU</category>',
      ),
    );
    const item = (await fetchFeed('https://example.com/rss')).items[0];
    expect(item.categoryTerms).toEqual([
      { term: 'DEF04', domain: 'nutsCodes' },
      { term: 'Musterstraße 1, 24103 Kiel, DEU', domain: 'locations' },
    ]);
    // categories stays the flat, attribute-free view — the term, never '[object Object]'.
    expect(item.categories).toEqual(['DEF04', 'Musterstraße 1, 24103 Kiel, DEU']);
  });

  it('handles a feed mixing bare and attribute-carrying categories', async () => {
    stubFetch(
      feedXml(
        '<category>90911200</category>' +
          '<category>open</category>' +
          '<category domain="nutsCodes">DEF04</category>',
      ),
    );
    const item = (await fetchFeed('https://example.com/rss')).items[0];
    expect(item.categories).toEqual(['90911200', 'open', 'DEF04']);
    expect(item.categoryTerms).toEqual([
      { term: '90911200' },
      { term: 'open' },
      { term: 'DEF04', domain: 'nutsCodes' },
    ]);
  });

  // WordPress emits this on every post; it broke the connector the same way.
  it('handles WordPress-style categories with extra attributes', async () => {
    stubFetch(feedXml('<category domain="category" nicename="news">News</category>'));
    const item = (await fetchFeed('https://example.com/rss')).items[0];
    expect(item.categories).toEqual(['News']);
    expect(item.categoryTerms).toEqual([{ term: 'News', domain: 'category' }]);
  });

  it('drops an empty category rather than emitting a blank term', async () => {
    stubFetch(feedXml('<category domain="nutsCodes"></category><category>open</category>'));
    const item = (await fetchFeed('https://example.com/rss')).items[0];
    expect(item.categories).toEqual(['open']);
  });

  it('yields no categories for an item that has none', async () => {
    stubFetch(feedXml(''));
    const item = (await fetchFeed('https://example.com/rss')).items[0];
    expect(item.categories).toEqual([]);
    expect(item.categoryTerms).toEqual([]);
  });
});
