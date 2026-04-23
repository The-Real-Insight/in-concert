/**
 * Microsoft Graph client for SharePoint drive item polling.
 *
 * Uses OAuth2 client-credentials (no MSAL dep) and the drive `/delta`
 * endpoint to fetch incremental changes to a folder. First call returns
 * the current state + a deltaLink; subsequent calls return only what
 * changed since.
 *
 * Scope: this module is plugin-owned; engine core has no knowledge of it.
 */

export type GraphCredentials = {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
};

export const DEFAULT_SHAREPOINT_POLL_SECONDS = parseInt(
  process.env.SHAREPOINT_POLL_SECONDS ?? '60',
  10,
);

type CachedToken = { accessToken: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

function envFallback(): GraphCredentials {
  return {
    tenantId: process.env.GRAPH_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET,
  };
}

function resolveCredentials(overrides?: GraphCredentials) {
  const env = envFallback();
  const tenantId = overrides?.tenantId || env.tenantId;
  const clientId = overrides?.clientId || env.clientId;
  const clientSecret = overrides?.clientSecret || env.clientSecret;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'SharePoint connector not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, ' +
        'and GRAPH_CLIENT_SECRET (or provide per-schedule credentials).',
    );
  }
  return { tenantId, clientId, clientSecret };
}

export async function getAccessToken(overrides?: GraphCredentials): Promise<string> {
  const { tenantId, clientId, clientSecret } = resolveCredentials(overrides);
  const cacheKey = `${tenantId}:${clientId}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token request failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const entry: CachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  tokenCache.set(cacheKey, entry);
  return entry.accessToken;
}

// ── Site / drive resolution ──────────────────────────────────────────────────

export type SiteRef = { siteId: string; driveId: string };

/**
 * Resolve `siteUrl` + optional `driveName` to (siteId, driveId). Cached
 * per (siteUrl, driveName) for the process lifetime — these rarely change.
 */
const siteRefCache = new Map<string, SiteRef>();

export async function resolveSiteAndDrive(
  siteUrl: string,
  driveName: string | null | undefined,
  credentials?: GraphCredentials,
): Promise<SiteRef> {
  const cacheKey = `${siteUrl}|${driveName ?? ''}`;
  const cached = siteRefCache.get(cacheKey);
  if (cached) return cached;

  const token = await getAccessToken(credentials);
  const host = new URL(siteUrl).host;
  const path = new URL(siteUrl).pathname.replace(/\/+$/, '');

  // Resolve site by hostname + server-relative path.
  const siteRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${host}:${encodeURI(path)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!siteRes.ok) {
    const text = await siteRes.text();
    throw new Error(`Resolve site failed (${siteRes.status}): ${text}`);
  }
  const siteJson = (await siteRes.json()) as { id: string };

  // Resolve drive. If driveName is set, pick by name; else use the default library.
  const drivesRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteJson.id}/drives`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!drivesRes.ok) {
    const text = await drivesRes.text();
    throw new Error(`Resolve drives failed (${drivesRes.status}): ${text}`);
  }
  const drivesJson = (await drivesRes.json()) as { value: Array<{ id: string; name: string }> };

  let driveId: string;
  if (driveName) {
    const match = drivesJson.value.find((d) => d.name === driveName);
    if (!match) {
      throw new Error(`No drive named "${driveName}" on site ${siteUrl}`);
    }
    driveId = match.id;
  } else {
    const defaultRes = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteJson.id}/drive`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!defaultRes.ok) {
      const text = await defaultRes.text();
      throw new Error(`Resolve default drive failed (${defaultRes.status}): ${text}`);
    }
    const defaultJson = (await defaultRes.json()) as { id: string };
    driveId = defaultJson.id;
  }

  const ref: SiteRef = { siteId: siteJson.id, driveId };
  siteRefCache.set(cacheKey, ref);
  return ref;
}

// ── Delta query ──────────────────────────────────────────────────────────────

export type DriveItem = {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: { path?: string };
  file?: { mimeType?: string; hashes?: Record<string, unknown> };
  folder?: { childCount?: number };
  deleted?: { state: string };
};

export type DeltaResponse = {
  items: DriveItem[];
  nextLink?: string;
  deltaLink?: string;
};

export const DELTA_TOKEN_EXPIRED_STATUS = 410;

export class DeltaExpiredError extends Error {
  constructor() {
    super('SharePoint delta token expired (HTTP 410)');
    this.name = 'DeltaExpiredError';
  }
}

/**
 * Perform a delta call. Pass `deltaUrl` from a prior response's deltaLink
 * for incremental changes; pass null to start from the current state (no
 * changes emitted by the caller). Handles `@odata.nextLink` pagination.
 */
export async function deltaRequest(
  driveId: string,
  folderPath: string,
  deltaUrl: string | null,
  credentials?: GraphCredentials,
): Promise<DeltaResponse> {
  const token = await getAccessToken(credentials);
  let url: string;
  if (deltaUrl) {
    url = deltaUrl;
  } else {
    const encoded = folderPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encoded}:/delta`;
  }

  const items: DriveItem[] = [];
  let nextLink: string | undefined;
  let finalDeltaLink: string | undefined;

  while (true) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === DELTA_TOKEN_EXPIRED_STATUS) {
      throw new DeltaExpiredError();
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Delta request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as {
      value?: DriveItem[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    if (json.value) items.push(...json.value);
    if (json['@odata.nextLink']) {
      url = json['@odata.nextLink'];
      continue;
    }
    finalDeltaLink = json['@odata.deltaLink'];
    nextLink = undefined;
    break;
  }

  return { items, nextLink, deltaLink: finalDeltaLink };
}

/**
 * Download a drive item's content as a Buffer. Uses Graph's
 * `/drives/{id}/items/{itemId}/content` endpoint — this issues a 302 redirect
 * to short-lived CDN storage. `fetch` follows redirects by default.
 *
 * The on-demand shape is intentional: most hosts only want the metadata and
 * a handful of filtered items' content, so we don't pre-download everything
 * during the delta poll.
 */
export async function getDriveItemContent(
  driveId: string,
  itemId: string,
  credentials?: GraphCredentials,
): Promise<Buffer> {
  const token = await getAccessToken(credentials);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Fetching drive item content failed (${res.status}) for ${driveId}/${itemId}: ${text}`,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
