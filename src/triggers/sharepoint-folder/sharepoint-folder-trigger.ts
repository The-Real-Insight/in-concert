/**
 * SharePoint folder trigger. Watches a SharePoint document-library folder
 * via the Microsoft Graph `/delta` endpoint and starts a process instance
 * for each new (or modified, if enabled) file that matches the filter.
 *
 * The plugin owns its Graph credentials. Engine core has no knowledge
 * of SharePoint or Azure AD.
 *
 * Cursor contents: `{ deltaLink }` — the opaque URL returned by Graph.
 * Each fire calls `/delta` with that URL, emits one StartRequest per
 * matching item, and returns the new deltaLink as `nextCursor`.
 *
 * First-poll behavior: if initialPolicy='skip-existing' (spec default),
 * the first delta call primes the cursor without emitting any starts —
 * existing files aren't treated as "new". Set `tri:initialPolicy` on the
 * BPMN message to override.
 */
import {
  deltaRequest,
  resolveSiteAndDrive,
  DeltaExpiredError,
  DEFAULT_SHAREPOINT_POLL_SECONDS,
  type DriveItem,
  type GraphCredentials,
} from './graph-client';
import type {
  StartRequest,
  StartTrigger,
  TriggerCursor,
  TriggerDefinition,
  TriggerInvocation,
  TriggerResult,
  TriggerSchedule,
} from '../types';

export const SHAREPOINT_FOLDER_TRIGGER_TYPE = 'sharepoint-folder';

const MIN_POLL_SECONDS = 15;

export class SharePointFolderTrigger implements StartTrigger {
  readonly triggerType = SHAREPOINT_FOLDER_TRIGGER_TYPE;
  readonly defaultInitialPolicy = 'skip-existing' as const;

  validate(def: TriggerDefinition): void {
    const cfg = def.config;
    const siteUrl = cfg['siteUrl'];
    const folderPath = cfg['folderPath'];
    if (typeof siteUrl !== 'string' || !siteUrl.match(/^https?:\/\//)) {
      throw new Error('sharepoint-folder trigger requires tri:siteUrl (http/https URL)');
    }
    if (typeof folderPath !== 'string' || !folderPath.startsWith('/')) {
      throw new Error('sharepoint-folder trigger requires tri:folderPath (leading slash)');
    }
    const pollSeconds = parsePollSeconds(cfg['pollIntervalSeconds']);
    if (pollSeconds < MIN_POLL_SECONDS) {
      throw new Error(
        `sharepoint-folder tri:pollIntervalSeconds must be >= ${MIN_POLL_SECONDS} (got ${pollSeconds})`,
      );
    }
    const pattern = asString(cfg['fileNamePattern']) ?? '*';
    // Glob-style pattern: allow alphanumerics, common filename characters,
    // and the two wildcards * and ?. Reject anything that looks like a
    // regex attempt (parens, brackets, braces, pipe, anchors).
    if (/[\\\^\$\(\)\[\]\{\}\|]/.test(pattern)) {
      throw new Error(
        `sharepoint-folder tri:fileNamePattern may only contain "*" and "?" wildcards (got "${pattern}")`,
      );
    }
    const itemType = asString(cfg['itemType']) ?? 'file';
    if (!['file', 'folder', 'any'].includes(itemType)) {
      throw new Error(
        `sharepoint-folder tri:itemType must be "file", "folder", or "any" (got "${itemType}")`,
      );
    }
  }

  nextSchedule(
    def: TriggerDefinition,
    _lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    const pollSeconds = parsePollSeconds(def.config['pollIntervalSeconds']);
    return { kind: 'interval', ms: pollSeconds * 1000 };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    const cfg = invocation.definition.config;
    const siteUrl = asString(cfg['siteUrl'])!;
    const folderPath = asString(cfg['folderPath'])!;
    const driveName = asString(cfg['driveName']) ?? 'Documents';
    const recursive = asBool(cfg['recursive'], false);
    const includeModifications = asBool(cfg['includeModifications'], false);
    const pattern = asString(cfg['fileNamePattern']) ?? '*';
    const minSize = parseIntOrZero(cfg['minFileSizeBytes']);
    const itemType = asString(cfg['itemType']) ?? 'file';
    const initialPolicy = asString(cfg['initialPolicy']) ?? 'skip-existing';

    const credentials = extractCredentials(invocation.credentials);

    let siteRef;
    try {
      siteRef = await resolveSiteAndDrive(siteUrl, driveName, credentials);
    } catch (err) {
      throw new Error(
        `Resolving SharePoint site/drive failed for ${siteUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const cursorParsed = decodeCursor(invocation.cursor);
    const isFirstPoll = cursorParsed === null;
    const deltaUrl = cursorParsed?.deltaLink ?? null;

    let delta;
    try {
      delta = await deltaRequest(siteRef.driveId, folderPath, deltaUrl, credentials);
    } catch (err) {
      if (err instanceof DeltaExpiredError) {
        // Expired — reset and prime without starts, per spec.
        const reset = await deltaRequest(siteRef.driveId, folderPath, null, credentials);
        return {
          starts: [],
          nextCursor: encodeCursor({ deltaLink: reset.deltaLink ?? null }),
        };
      }
      throw err;
    }

    // First-poll-skip-existing: swallow whatever the initial delta returned.
    if (isFirstPoll && initialPolicy === 'skip-existing') {
      return {
        starts: [],
        nextCursor: encodeCursor({ deltaLink: delta.deltaLink ?? null }),
      };
    }

    const starts: StartRequest[] = [];
    const folderPathNormalized = folderPath.replace(/\/+$/, '');

    for (const item of delta.items) {
      // Deleted items never fire.
      if (item.deleted) continue;

      const isFolder = Boolean(item.folder);
      const isFile = Boolean(item.file);
      if (itemType === 'file' && !isFile) continue;
      if (itemType === 'folder' && !isFolder) continue;
      if (itemType === 'any' && !isFile && !isFolder) continue;

      // Partial-upload guard: skip files with size 0 or no hashes yet.
      if (isFile) {
        const size = item.size ?? 0;
        if (size === 0) continue;
        if (!item.file?.hashes) continue;
        if (size < minSize) continue;
      }

      if (!matchesPattern(item.name, pattern)) continue;

      // Scope filter: non-recursive mode drops items in subfolders below
      // the watched folder.
      if (!recursive) {
        const parentPath = item.parentReference?.path ?? '';
        // Graph returns parentReference.path like "/drives/<id>/root:/Incoming".
        const normalized = parentPath.replace(/^\/drives\/[^/]+\/root:/, '');
        if (normalized !== folderPathNormalized) continue;
      }

      // Modifications: without includeModifications, we can't perfectly
      // distinguish "new" from "modified" via /delta alone — Graph doesn't
      // tag the change type. Heuristic: if createdDateTime === lastModifiedDateTime,
      // treat as new; otherwise modification. Err toward fire-only-new.
      if (!includeModifications) {
        const created = item.createdDateTime ?? '';
        const modified = item.lastModifiedDateTime ?? '';
        if (created && modified && created !== modified) continue;
      }

      const eTag = item.eTag ?? '';
      starts.push({
        dedupKey: `${item.id}@${eTag}`,
        payload: {
          sharepoint: {
            driveId: siteRef.driveId,
            itemId: item.id,
            name: item.name,
            path: (item.parentReference?.path ?? '').replace(/^\/drives\/[^/]+\/root:/, '') +
              '/' + item.name,
            webUrl: item.webUrl ?? '',
            size: item.size ?? 0,
            createdDateTime: item.createdDateTime ?? '',
            lastModifiedDateTime: item.lastModifiedDateTime ?? '',
            mimeType: item.file?.mimeType ?? null,
            isFolder,
            eTag,
          },
        },
      });
    }

    return {
      starts,
      nextCursor: encodeCursor({ deltaLink: delta.deltaLink ?? null }),
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type ParsedCursor = { deltaLink: string | null } | null;

function decodeCursor(c: TriggerCursor): ParsedCursor {
  if (c === null) return null;
  try {
    return JSON.parse(c) as ParsedCursor;
  } catch {
    return null;
  }
}

function encodeCursor(c: { deltaLink: string | null }): TriggerCursor {
  return JSON.stringify(c);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function parseIntOrZero(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parsePollSeconds(v: unknown): number {
  const n = parseIntOrZero(v);
  return n > 0 ? n : DEFAULT_SHAREPOINT_POLL_SECONDS;
}

function extractCredentials(
  creds: Record<string, unknown> | null,
): GraphCredentials | undefined {
  if (!creds) return undefined;
  const tenantId = asString(creds.tenantId);
  const clientId = asString(creds.clientId);
  const clientSecret = asString(creds.clientSecret);
  if (!tenantId && !clientId && !clientSecret) return undefined;
  return { tenantId, clientId, clientSecret };
}

/** Glob match with `*` and `?`. Case-insensitive, same rules as the validator. */
function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return regex.test(name);
}
