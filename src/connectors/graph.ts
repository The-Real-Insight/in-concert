/**
 * Microsoft Graph API client for mailbox polling.
 *
 * Uses OAuth2 client credentials flow (no MSAL dependency).
 * Polls /users/{mailbox}/messages for unread emails.
 */
import { config } from '../config';

// ── Token cache ──────────────────────────────────────────────────────────────

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  const { tenantId, clientId, clientSecret } = config.graph;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Graph connector not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, and GRAPH_CLIENT_SECRET.'
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
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
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

// ── Email types ──────────────────────────────────────────────────────────────

export interface GraphEmail {
  id: string;
  subject: string;
  from: { emailAddress: { name?: string; address: string } };
  toRecipients: Array<{ emailAddress: { name?: string; address: string } }>;
  receivedDateTime: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  hasAttachments: boolean;
}

// ── Polling ──────────────────────────────────────────────────────────────────

export async function pollMailbox(
  mailbox: string,
  options?: { sinceMinutes?: number; top?: number }
): Promise<GraphEmail[]> {
  const token = await getAccessToken();
  const sinceMinutes = options?.sinceMinutes ?? config.graph.sinceMinutes;
  const top = options?.top ?? 10;

  const since = new Date();
  since.setMinutes(since.getMinutes() - sinceMinutes);

  const filter = `isRead eq false and receivedDateTime ge ${since.toISOString()}`;
  const select = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments';

  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$top=${top}` +
    `&$orderby=receivedDateTime desc` +
    `&$select=${select}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph poll failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { value: GraphEmail[] };
  return json.value ?? [];
}

// ── Attachments ──────────────────────────────────────────────────────────────

export interface GraphAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

/**
 * List attachment metadata for a message (no content downloaded).
 * Uses $select to exclude contentBytes — safe for any attachment size.
 */
export async function listAttachments(mailbox: string, messageId: string): Promise<GraphAttachmentMeta[]> {
  const token = await getAccessToken();
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}` +
    `/messages/${messageId}/attachments?$select=id,name,contentType,size`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph list attachments failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { value: Array<Record<string, unknown>> };
  return (json.value ?? [])
    .filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map(a => ({
      id: String(a.id),
      name: String(a.name ?? ''),
      contentType: String(a.contentType ?? 'application/octet-stream'),
      size: Number(a.size ?? 0),
    }));
}

/**
 * Download a single attachment's content as a Buffer.
 * Fetches only the requested attachment — no bulk loading.
 */
export async function getAttachmentContent(
  mailbox: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const token = await getAccessToken();
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}` +
    `/messages/${messageId}/attachments/${attachmentId}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph attachment download failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { contentBytes?: string };
  if (!json.contentBytes) throw new Error(`Attachment ${attachmentId} has no content`);
  return Buffer.from(json.contentBytes, 'base64');
}

// ── Mark as read ─────────────────────────────────────────────────────────────

export async function markAsRead(mailbox: string, messageId: string): Promise<void> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  });
  if (!res.ok) {
    console.error(`[Graph] Failed to mark message ${messageId} as read: ${res.status}`);
  }
}
