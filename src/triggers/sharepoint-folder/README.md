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

## Process payload

Each fire produces a `StartRequest` with this payload shape, available as process variables once the instance starts:

```ts
{
  sharepoint: {
    driveId: string;
    itemId: string;
    name: string;
    path: string;        // server-relative
    webUrl: string;
    size: number;
    createdDateTime: string;
    lastModifiedDateTime: string;
    mimeType: string | null;
    isFolder: boolean;
    eTag: string;
  }
}
```

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
