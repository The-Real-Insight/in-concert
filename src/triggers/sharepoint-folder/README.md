# SharePoint folder trigger

Starts a process instance for each new (or modified) file arriving in a SharePoint document-library folder. Uses the Microsoft Graph `/delta` endpoint — no full folder scans, no "mark as processed" dance.

## BPMN shape

```xml
<bpmn:message id="Msg_NewOrder" name="incoming-orders"
  tri:connectorType="sharepoint-folder"
  tri:siteUrl="https://contoso.sharepoint.com/sites/Operations"
  tri:driveName="Documents"
  tri:folderPath="/Incoming/Orders"
  tri:recursive="false"
  tri:includeModifications="false"
  tri:fileNamePattern="*.pdf"
  tri:minFileSizeBytes="0"
  tri:itemType="file"
  tri:pollIntervalSeconds="60"
  tri:initialPolicy="skip-existing" />

<bpmn:startEvent id="Start">
  <bpmn:messageEventDefinition messageRef="Msg_NewOrder" />
</bpmn:startEvent>
```

## `tri:*` attributes

| Attribute | Required | Default | Meaning |
|---|---|---|---|
| `tri:connectorType` | yes | — | Must be `"sharepoint-folder"`. |
| `tri:siteUrl` | yes | — | SharePoint site URL. Resolved to `siteId` at deploy time and cached per-process. |
| `tri:driveName` | no | `"Documents"` | Document library to watch. |
| `tri:folderPath` | yes | — | Server-relative folder path, leading slash. |
| `tri:recursive` | no | `"false"` | `"true"` watches subfolders; `"false"` only direct children. |
| `tri:includeModifications` | no | `"false"` | `"true"` also fires on edits; `"false"` only on new files. |
| `tri:fileNamePattern` | no | `"*"` | Glob filter on `name`. Only `*` and `?` are wildcards — everything else is literal. |
| `tri:minFileSizeBytes` | no | `"0"` | Skip items smaller than this (guards against partial uploads). |
| `tri:itemType` | no | `"file"` | `"file"`, `"folder"`, or `"any"`. |
| `tri:pollIntervalSeconds` | no | `"60"` | Polling cadence. Minimum `15`. |
| `tri:initialPolicy` | no | `"skip-existing"` | `"fire-existing"` fires for every file on the very first poll; `"skip-existing"` primes the cursor silently. |

`validate()` rejects the deploy if:

- `siteUrl` is missing or not `http(s)`.
- `folderPath` is missing or doesn't start with `/`.
- `pollIntervalSeconds < 15`.
- `fileNamePattern` contains regex metacharacters other than `*` / `?`.
- `itemType` is not in the allowed set.

## Credentials

Azure AD app with **`Sites.Read.All`** (or narrower scope appropriate to your tenant). Same credential model as the graph-mailbox trigger:

- **Per-schedule:** `client.setTriggerCredentials(scheduleId, { tenantId, clientId, clientSecret })`.
- **Fallback:** `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` env vars.

Per-schedule takes precedence.

## Lifecycle and the `onFileReceived` hook

Every matching delta item runs through this sequence, inside the plugin:

1. Idempotency check — if a `ProcessInstance` already exists for this `(definitionId, scheduleId:itemId@eTag)`, skip; the prior fire already handled it.
2. `startInstance(..., deferContinuation: true)` — create the `ProcessInstance` row but **do not** kick off BPMN execution yet.
3. Await the host's `onFileReceived(event)` callback if registered. This is where the host typically:
   - Downloads the file content via `event.getFileContent()`.
   - Stashes bytes in blob storage / seeds a data-pool / creates a conversation thread — anything that should exist before the first BPMN step runs.
   - Returns `{ skip: true }` to cancel (duplicate, filter miss, business rule). A thrown error is treated as skip so a buggy callback cannot leave half-configured instances running.
4. If not skipped, insert the START continuation — the engine's main worker loop picks the instance up and runs it.
5. If skipped, terminate the instance (`status: 'TERMINATED'`).

Set the callback at init time:

```ts
import { getDefaultTriggerRegistry } from '@the-real-insight/in-concert/triggers';

const sp = getDefaultTriggerRegistry().get('sharepoint-folder') as SharePointFolderTrigger;
sp.setOnFileReceived(async (event) => {
  if (event.file.size > 50_000_000) return { skip: true };   // too big for us
  const bytes = await event.getFileContent();
  await myBlobStore.put(`files/${event.instanceId}/${event.file.name}`, bytes);
  await mySeedDataPool(event.instanceId, {
    fileName: event.file.name,
    mimeType: event.file.mimeType,
    webUrl: event.file.webUrl,
  });
  // undefined → run the process
});
```

Or pass it when you construct a trigger yourself:

```ts
import { SharePointFolderTrigger, TriggerRegistry } from '@the-real-insight/in-concert/triggers';

const registry = new TriggerRegistry();
registry.register(new SharePointFolderTrigger({ onFileReceived: myHook }));
```

### `FileReceivedEvent`

```ts
type FileReceivedEvent = {
  siteUrl: string;
  driveId: string;
  driveName: string;
  folderPath: string;
  instanceId: string;          // the just-created process instance
  definitionId: string;
  file: {
    itemId: string;
    name: string;
    path: string;              // server-relative, includes file name
    webUrl: string;
    size: number;
    mimeType: string | null;
    isFolder: boolean;
    eTag: string;
    createdDateTime: string;
    lastModifiedDateTime: string;
  };
  getFileContent: () => Promise<Buffer>;   // lazy download, cached per event
};
```

`getFileContent()` hits Graph's `/drives/{id}/items/{itemId}/content`. Call it only when you need the bytes — a filter pass that only inspects metadata doesn't incur the download. Throws for folders.

If no `onFileReceived` is set, every matching item falls straight through to step 4: the process starts with just the metadata available as process variables.

## Dedup key

`${itemId}@${eTag}`. The eTag bumps when the file is modified, so with `tri:includeModifications="true"` each edit fires a new instance. With the default `"false"`, only the first version fires.

## Gotchas

1. **Partial uploads.** Graph's `/delta` can return an item mid-upload. The trigger skips items with `size === 0` or missing `file.hashes`. The finished upload fires the next cycle.
2. **Delta token expiration.** Graph invalidates delta tokens after ~30 days of inactivity. When the API returns `410 Gone`, the trigger transparently resets: it performs a fresh baseline call (emitting no starts), stores the new deltaLink, and waits for the next cycle. A warning is logged.
3. **Renames count as modifications** in Graph's delta feed. With `includeModifications="false"` (default), renames don't fire.
4. **Deletions never fire.** Deletion-triggered starts are a planned follow-up.
5. **Folder paths with spaces / Unicode** are URL-encoded correctly — use the literal path as it appears in SharePoint, no encoding needed in the BPMN.

## See also

- Full interface: [`src/triggers/types.ts`](../types.ts).
- Writing your own: [`docs/sdk/custom-triggers.md`](../../../docs/sdk/custom-triggers.md).
