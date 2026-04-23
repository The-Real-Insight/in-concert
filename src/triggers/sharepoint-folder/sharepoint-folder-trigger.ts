/**
 * SharePoint folder trigger. Watches a SharePoint document-library folder
 * via the Microsoft Graph `/delta` endpoint and starts a process instance
 * for each new (or modified, if enabled) file that matches the filter.
 *
 * The plugin owns its Graph credentials. Engine core has no knowledge
 * of SharePoint or Azure AD.
 *
 * Cursor contents: `{ deltaLink }` — the opaque URL returned by Graph.
 * Each fire calls `/delta` with that URL and processes each matching
 * delta item inline: creates the `ProcessInstance` (deferred), invokes
 * the host's `onFileReceived` callback (if set) so the host can stash
 * content / seed data-pools / create conversations, and then either
 * terminates the instance (`{ skip: true }`) or inserts the START
 * continuation. The new `deltaLink` is returned as `nextCursor`.
 *
 * First-poll behavior: if initialPolicy='skip-existing' (spec default),
 * the first delta call primes the cursor without emitting any starts —
 * existing files aren't treated as "new". Set `tri:initialPolicy` on the
 * BPMN message to override.
 *
 * Exactly-once: each fired item carries `idempotencyKey = scheduleId:itemId@eTag`.
 * The unique `ProcessInstance(definitionId, idempotencyKey)` index collapses
 * retries of the same logical fire to one instance.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import {
  deltaRequest,
  resolveSiteAndDrive,
  getDriveItemContent,
  DeltaExpiredError,
  DEFAULT_SHAREPOINT_POLL_SECONDS,
  type DriveItem,
  type GraphCredentials,
} from './graph-client';
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

export const SHAREPOINT_FOLDER_TRIGGER_TYPE = 'sharepoint-folder';

const MIN_POLL_SECONDS = 15;

/**
 * Event handed to the host's `onFileReceived` callback for every matching
 * delta item, after the `ProcessInstance` has been created but before BPMN
 * execution begins. The host can:
 *
 *   - Download file content on demand via `getFileContent()`.
 *   - Stash the file in blob storage, seed data-pools, create a conversation,
 *     or attach it to the instance in any other host-specific way.
 *   - Return `{ skip: true }` to terminate the instance without running the
 *     process (e.g. duplicate, filtered, business rule).
 */
export type FileReceivedEvent = {
  /** SharePoint site URL the schedule watches. */
  siteUrl: string;
  /** Resolved Graph drive id (document library). */
  driveId: string;
  /** Document library name (e.g. "Documents"). */
  driveName: string;
  /** Watched folder path, as configured on the BPMN (leading slash). */
  folderPath: string;
  /** The process instance that was just created (still deferred). */
  instanceId: string;
  /** The process definition this instance belongs to. */
  definitionId: string;
  /** File (or folder) metadata from the delta response. */
  file: {
    itemId: string;
    name: string;
    /** Folder-relative path including file name. */
    path: string;
    webUrl: string;
    size: number;
    mimeType: string | null;
    isFolder: boolean;
    eTag: string;
    createdDateTime: string;
    lastModifiedDateTime: string;
  };
  /**
   * Download the item's content on demand. Only use when the size is
   * reasonable for your host — files up to the low-GB range work, but very
   * large ones should be streamed elsewhere. Folders have no content and
   * will throw.
   */
  getFileContent: () => Promise<Buffer>;
};

export type FileReceivedResult = { skip?: boolean } | undefined | void;

export type OnFileReceivedFn = (event: FileReceivedEvent) => Promise<FileReceivedResult>;

function toFileEvent(
  siteUrl: string,
  driveId: string,
  driveName: string,
  folderPath: string,
  item: DriveItem,
  instanceId: string,
  definitionId: string,
  credentials: GraphCredentials | undefined,
): FileReceivedEvent {
  const isFolder = Boolean(item.folder);
  const parentPath = (item.parentReference?.path ?? '')
    .replace(/^\/drives\/[^/]+\/root:/, '');
  return {
    siteUrl,
    driveId,
    driveName,
    folderPath,
    instanceId,
    definitionId,
    file: {
      itemId: item.id,
      name: item.name,
      path: parentPath + '/' + item.name,
      webUrl: item.webUrl ?? '',
      size: item.size ?? 0,
      mimeType: item.file?.mimeType ?? null,
      isFolder,
      eTag: item.eTag ?? '',
      createdDateTime: item.createdDateTime ?? '',
      lastModifiedDateTime: item.lastModifiedDateTime ?? '',
    },
    getFileContent: () => {
      if (isFolder) {
        return Promise.reject(new Error(`Drive item ${item.id} is a folder; no content to fetch.`));
      }
      return getDriveItemContent(driveId, item.id, credentials);
    },
  };
}

export class SharePointFolderTrigger implements StartTrigger {
  readonly triggerType = SHAREPOINT_FOLDER_TRIGGER_TYPE;
  readonly defaultInitialPolicy = 'skip-existing' as const;

  private onFileReceived: OnFileReceivedFn | null = null;

  constructor(options?: { onFileReceived?: OnFileReceivedFn }) {
    this.onFileReceived = options?.onFileReceived ?? null;
  }

  /**
   * Configure the `onFileReceived` hook after construction — used when the
   * engine's default registry already holds a trigger instance and the host
   * wants to wire in its own per-file callback at init time.
   */
  setOnFileReceived(fn: OnFileReceivedFn | null): void {
    this.onFileReceived = fn;
  }

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    // Accept the attribute in either spot: on the referenced <bpmn:message>
    // (message start) or inline on the start event / conditional event
    // definition. Portals free to pick the authoring shape that fits best.
    const fromMessage = event.messageAttrs?.['tri:connectorType'];
    const fromSelf = event.selfAttrs['tri:connectorType'];
    const source =
      fromMessage === SHAREPOINT_FOLDER_TRIGGER_TYPE
        ? event.messageAttrs!
        : fromSelf === SHAREPOINT_FOLDER_TRIGGER_TYPE
        ? event.selfAttrs
        : null;
    if (!source) return null;
    return { config: stripTriPrefix(source, ['connectorType']) };
  }

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

    // Per-item instance creation happens inline so we can invoke
    // `onFileReceived` between instance creation and START continuation
    // insertion — mirror of the graph-mailbox lifecycle.
    const { ProcessInstances } = getCollections(invocation.db);
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
      const idempotencyKey = `${invocation.scheduleId}:${item.id}@${eTag}`;

      const existing = await ProcessInstances.findOne(
        { definitionId: invocation.definition.definitionId, idempotencyKey },
        { projection: { _id: 1 } },
      );
      if (existing) continue; // already processed in a prior (possibly crashed) fire

      const commandId = uuidv4();
      const { instanceId } = await startInstance(invocation.db, {
        commandId,
        definitionId: invocation.definition.definitionId,
        businessKey: `sharepoint:${item.id}@${eTag}`,
        idempotencyKey,
        deferContinuation: true,
      });

      let skip = false;
      if (this.onFileReceived) {
        try {
          const r = await this.onFileReceived(
            toFileEvent(
              siteUrl,
              siteRef.driveId,
              driveName,
              folderPath,
              item,
              instanceId,
              invocation.definition.definitionId,
              credentials,
            ),
          );
          if (r?.skip) skip = true;
        } catch (err) {
          console.error(`[sharepoint-folder] onFileReceived threw for ${item.id}:`, err);
          skip = true;
        }
      }

      if (skip) {
        await terminateInstance(invocation.db, instanceId);
      } else {
        await insertStartContinuation(invocation.db, { instanceId, commandId });
      }
    }

    // Instance creation happened inline above; report no starts to the
    // scheduler. All we need from it is the cursor advance.
    return {
      starts: [],
      nextCursor: encodeCursor({ deltaLink: delta.deltaLink ?? null }),
    };
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
