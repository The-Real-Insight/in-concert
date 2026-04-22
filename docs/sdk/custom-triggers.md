# Writing a custom start trigger

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

in-concert ships three built-in start triggers (`timer`, `graph-mailbox`, `sharepoint-folder`), but the trigger system is pluggable. This guide walks through building your own — e.g. a webhook receiver, an S3 bucket watcher, an SQS queue poller — registering it with the engine, and using it from BPMN.

---

## What you'll build

A toy **filesystem folder watcher** that starts a process instance every time a new file appears in a local directory. It's deliberately simple — roughly 80 lines of code — so the interface surface is the focus, not the plumbing.

By the end you'll have:

- `MyFsWatcherTrigger` implementing the `StartTrigger` interface.
- Registration in your engine's trigger registry.
- A BPMN message start event with `tri:connectorType="fs-watcher"`.
- Exactly-once instance creation — dropping the same file twice produces one instance.

---

## The `StartTrigger` contract

A trigger is any object that conforms to this interface (full signature in `src/triggers/types.ts`):

```typescript
export type StartTrigger = {
  readonly triggerType: string;
  readonly defaultInitialPolicy: 'fire-existing' | 'skip-existing';
  readonly deployStatus?: 'ACTIVE' | 'PAUSED'; // optional; see "Deploy status"

  /** Given a parsed BPMN start event, own it or pass. First non-null wins. */
  claimFromBpmn(event: BpmnStartEventView): { config: Record<string, unknown> } | null;

  validate(def: TriggerDefinition): void;

  nextSchedule(
    def: TriggerDefinition,
    lastFiredAt: Date | null,
    cursor: TriggerCursor,
  ): TriggerSchedule;

  fire(invocation: TriggerInvocation): Promise<TriggerResult>;
};
```

The interface is intentionally small — everything trigger-specific lives *inside* the plugin, including the recognition rule that decides which BPMN start events belong to this trigger.

| Field | Purpose |
|---|---|
| `triggerType` | Stable id persisted on `TriggerSchedule.triggerType`. Chosen by the plugin; the engine never compares it to specific values. |
| `defaultInitialPolicy` | On first poll, should existing items fire starts or be skipped? Override per-schedule with `tri:initialPolicy` on the BPMN. |
| `deployStatus` (optional) | When set (e.g. `'ACTIVE'` for timer), redeploying the BPMN re-asserts that status. When omitted, status is `'PAUSED'` on first insert and preserved across redeploys. |
| `claimFromBpmn` | Given a parsed start event (raw `tri:*` attribute bags + BPMN primitives), decide whether this trigger owns it. Return a `{ config }` bag — stored verbatim on the schedule row and handed back at `fire()` time. Return `null` to pass. |
| `validate` | Called at deploy time with the claim's config. Throw with a human-readable message if invalid — the engine surfaces it as a deploy error. |
| `nextSchedule` | How often/when to fire. `{ kind: 'fire-at', at: Date }` for one-shots (timer), `{ kind: 'interval', ms: number }` for polling triggers. |
| `fire` | The actual work. Called by the scheduler when the trigger is due. Returns the `StartRequest`s plus an updated cursor. |

### What the engine passes to `claimFromBpmn`

```typescript
type BpmnStartEventView = {
  nodeId: string;
  timerDefinition?: string;                                                    // `<bpmn:timeDate|timeDuration|timeCycle>` body
  eventDefinitionKind: 'none' | 'timer' | 'message' | 'conditional' | 'signal' | 'other';
  selfAttrs: Record<string, string>;                                           // tri:* on the start event + nested event-def
  messageAttrs?: Record<string, string>;                                       // tri:* on the referenced <bpmn:message>, if any
};
```

The two attribute bags are **verbatim** — keys are fully qualified (`tri:connectorType`, `tri:path`, …). The engine does not interpret them. You pick which bag your trigger reads from (or both), pattern-match on whichever attribute discriminates "yours" from "theirs", and return whatever config shape your `fire()` wants.

Common helper: `stripTriPrefix(attrs, ['connectorType'])` from `@the-real-insight/in-concert/triggers` drops the `tri:` prefix and optionally omits the discriminator since your `triggerType` already names what kind of trigger this is.

---

## The exactly-once guarantee

The engine guarantees that **two `StartRequest`s with the same `dedupKey`** (within the same process definition) produce a single process instance — across crashes, retries, and overlapping polls. Your trigger is responsible for producing *stable* dedup keys.

Good dedup-key choices:

| Trigger | Key pattern |
|---|---|
| Webhook | request id (if the sender provides one) |
| S3 object created | `${bucketName}/${objectKey}@${eTag}` |
| SQS message | message id |
| Filesystem file | absolute path + mtime + size (or inode if available) |

If you can't produce a stable key, the engine can't dedupe. Pick something the upstream source gives you.

---

## Step 1 — Write the trigger

```typescript
// my-fs-watcher.ts
import { readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  stripTriPrefix,
  type BpmnClaim,
  type BpmnStartEventView,
  type StartTrigger,
  type TriggerCursor,
  type TriggerDefinition,
  type TriggerInvocation,
  type TriggerResult,
  type TriggerSchedule,
} from '@the-real-insight/in-concert/triggers';

type Cursor = { seen: string[] } | null;

export class FsWatcherTrigger implements StartTrigger {
  readonly triggerType = 'fs-watcher';
  readonly defaultInitialPolicy = 'skip-existing' as const;

  claimFromBpmn(event: BpmnStartEventView): BpmnClaim | null {
    // Accept the authoring convention of a bpmn:message with
    // tri:connectorType="fs-watcher", or the same attrs inline on a
    // conditional start event. Either shape works — the plugin decides.
    const fromMessage = event.messageAttrs?.['tri:connectorType'];
    const fromSelf = event.selfAttrs['tri:connectorType'];
    const source =
      fromMessage === 'fs-watcher' ? event.messageAttrs!
      : fromSelf === 'fs-watcher' ? event.selfAttrs
      : null;
    if (!source) return null;
    return { config: stripTriPrefix(source, ['connectorType']) };
  }

  validate(def: TriggerDefinition): void {
    const path = def.config['path'];
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('fs-watcher requires tri:path (absolute path)');
    }
  }

  nextSchedule(
    def: TriggerDefinition,
    _lastFiredAt: Date | null,
    _cursor: TriggerCursor,
  ): TriggerSchedule {
    const pollSeconds = Number(def.config['pollIntervalSeconds'] ?? 30);
    return { kind: 'interval', ms: pollSeconds * 1000 };
  }

  async fire(invocation: TriggerInvocation): Promise<TriggerResult> {
    const path = String(invocation.definition.config['path']);
    const policy = String(invocation.definition.config['initialPolicy'] ?? 'skip-existing');

    const parsed: Cursor = invocation.cursor ? JSON.parse(invocation.cursor) : null;
    const previouslySeen = new Set(parsed?.seen ?? []);
    const isFirstPoll = parsed === null;

    const files = readdirSync(path).map((name) => {
      const full = join(path, name);
      const stat = statSync(full);
      const fingerprint = createHash('sha256')
        .update(`${full}|${stat.mtimeMs}|${stat.size}`)
        .digest('hex')
        .slice(0, 16);
      return { name, full, fingerprint };
    });

    const newFiles = files.filter((f) => !previouslySeen.has(f.fingerprint));

    // Skip-existing on first poll: record without emitting.
    if (isFirstPoll && policy === 'skip-existing') {
      return {
        starts: [],
        nextCursor: JSON.stringify({ seen: files.map((f) => f.fingerprint) }),
      };
    }

    const starts = newFiles.map((f) => ({
      dedupKey: f.fingerprint,
      payload: { fsWatcher: { path: f.full, name: f.name } },
    }));

    return {
      starts,
      nextCursor: JSON.stringify({
        seen: files.map((f) => f.fingerprint),
      }),
    };
  }
}
```

Key design choices worth calling out:

- **Cursor is opaque JSON** — the engine never parses it. You're free to change the cursor shape between versions of your trigger; migrate on read.
- **Dedup key is a stable fingerprint** of `(path, mtime, size)`. If you replace the file with identical content, it won't re-fire (which is probably what you want).
- **First-poll policy is declarative** — `tri:initialPolicy="skip-existing"` on the BPMN, default chosen by `defaultInitialPolicy`.

### What the example handles (and what it doesn't)

The fingerprint-based design above is deliberately simple — it covers the common cases well, but has edges. Extend the example or pick a different detection strategy if the "No" rows matter for your use case.

| Event | Fires a process? | Why / how |
|---|---|---|
| **New file appears** in the watched folder | ✅ Yes | New path → new fingerprint → not in cursor `seen` set → start emitted. |
| **Existing file changed** (edited, grew, shrunk, new mtime) | ✅ Yes | Same path, but different `(mtime, size)` → new fingerprint → fresh start. |
| **File renamed** within the watched folder | ✅ Yes | New path → new fingerprint. The old name simply stops appearing. |
| **New subfolder** created in the watched folder | ✅ Yes | `readdirSync` lists it; `statSync` gives it a fingerprint. Payload doesn't distinguish folder from file, so extend with `stat.isDirectory()` if you care. |
| **File added inside a subfolder** | ❌ No | `readdirSync` is non-recursive in this example. Walk the tree with `readdirSync(..., { recursive: true })` if you need it. |
| **File deleted** | ❌ No | The trigger only emits on "things I haven't seen before." Deletion is not an event — the file just stops appearing. Track a parallel `previousPaths` set and diff it if you need delete notifications. |
| **`touch` with no content change** (mtime bumps, size same, hash same) | ✅ Yes, spuriously | Fingerprint is `(path, mtime, size)` — mtime bumped is enough to re-fire. Use a content hash in the fingerprint if that's wrong for you. |
| **Atomic editor rewrite** (tempfile + rename over original) | ✅ Yes | Most editors update mtime on rename, so the fingerprint changes. Safe default. |
| **Same file content re-uploaded** under the same name with the same mtime | ❌ No | Fingerprint matches — treated as the same file. Expected behavior for exactly-once. |
| **Crash mid-fire** (process dies between reading the directory and committing) | ✅ Yes, no duplicate | Cursor update is atomic with instance creation. On retry, fingerprints match and the idempotency index deduplicates. |

If the defaults don't fit, change one or two things:

- **Want deletion events?** Track `previousPaths` and emit `{ dedupKey: \`deleted:${path}@${timestamp}\`, payload: { action: 'deleted', path } }` for the diff.
- **Want recursion?** Replace `readdirSync(path)` with a recursive walk (or `readdirSync(path, { withFileTypes: true, recursive: true })` on Node ≥ 20).
- **Want to ignore touches?** Use a content hash (`sha256` over the first N KB, or the whole file if small) instead of mtime in the fingerprint.
- **Want to ignore partial uploads?** Skip entries where `size === 0` or where the file is newer than N seconds — same pattern the SharePoint trigger uses.

---

## Step 2 — Register the trigger

Once per engine init, before the first `deploy()`:

```typescript
import { BpmnEngineClient } from '@the-real-insight/in-concert/sdk';
import { getDefaultTriggerRegistry } from '@the-real-insight/in-concert/triggers';
import { FsWatcherTrigger } from './my-fs-watcher';

const engine = new BpmnEngineClient({ mode: 'local', db });
getDefaultTriggerRegistry().register(new FsWatcherTrigger());

engine.init({ onServiceCall, onWorkItem, onDecision });
await engine.recover();
```

If you want full isolation (useful for tests), construct your own registry instead of mutating the default:

```typescript
import { TriggerRegistry, registerBuiltInTriggers } from '@the-real-insight/in-concert/triggers';

const registry = new TriggerRegistry();
registerBuiltInTriggers(registry);
registry.register(new FsWatcherTrigger());
// ...pass `registry` to your own worker loops.
```

---

## Step 3 — Reference it from BPMN

```xml
<bpmn:message id="Msg_Inbox" name="fs-inbox"
  tri:connectorType="fs-watcher"
  tri:path="/var/data/inbox"
  tri:pollIntervalSeconds="30"
  tri:initialPolicy="skip-existing" />

<bpmn:startEvent id="Start">
  <bpmn:messageEventDefinition messageRef="Msg_Inbox" />
</bpmn:startEvent>
```

Deploy as usual:

```typescript
await engine.deploy({ id: 'inbox-watch', name: 'Watch Inbox', version: '1', bpmnXml });
```

At deploy time:

- `validate()` runs — a missing/invalid `tri:path` rejects the deploy.
- A `TriggerSchedule` row is written with `status='PAUSED'` (non-timer triggers deploy paused).

To start polling:

```typescript
const [schedule] = await engine.listTriggerSchedules({ triggerType: 'fs-watcher' });
await engine.resumeTriggerSchedule(schedule._id);
```

From here the generic trigger scheduler picks up due schedules and calls your `fire()`. Each `StartRequest` becomes a process instance with the dedup key applied.

- **REST mode:** the in-concert server runs `triggerLoop` in-process; no host action required.
- **Local mode:** the host must start the loop itself via `client.startTriggerScheduler()` — otherwise ACTIVE schedules sit in Mongo and never fire. See [usage.md → startTriggerScheduler](./usage.md#starttriggerscheduleroptions).

---

## What the engine does for you

You don't have to think about these — they're handled uniformly across all triggers:

- **Leasing + crash recovery.** The scheduler claims a schedule, calls `fire()`, and the sweeper reclaims the lease if the worker dies mid-call.
- **Atomic cursor advance.** `nextCursor` commits in the same transaction as the process instances created from `starts[]`. A crash mid-fire rolls back everything.
- **Idempotency.** Every `StartRequest.dedupKey` becomes an `idempotencyKey` on `ProcessInstance`, enforced by a partial unique index. Re-running `fire()` with the same inputs won't duplicate.
- **Credentials injection.** If the schedule row has `credentials`, they arrive on `invocation.credentials`. Env-var fallback is entirely up to the plugin.
- **Scheduling.** You return a `TriggerSchedule`; the scheduler handles "when next."
- **Pause/resume/observability.** SDK + REST methods for managing the schedule are free.

---

## Common gotchas

1. **Cursor must be serializable.** JSON.stringify it. The engine writes it as a string.
2. **`fire()` may run before `validate()` under race.** Your validator is called at deploy time, and again at the start of each fire through the config you read — don't skip checks inside `fire()`.
3. **Don't read credentials from the process environment inside `fire()` only.** Prefer reading them at construction (host-provided) or via `invocation.credentials`. Env lookups inside `fire()` make the trigger non-portable across hosts.
4. **The scheduler may call `fire()` concurrently on the same schedule in rare cases** (after lease expiration). Dedup via `dedupKey` handles it at the instance level, but if your `fire()` has external side effects (marking emails read, acknowledging an SQS message), make them idempotent too.

---

## Reference: the StartTrigger types

See [`src/triggers/types.ts`](../src/triggers/types.ts) for the full TypeScript interface and field docs. The built-in triggers are working examples:

- **Timer** — `src/triggers/timer/timer-trigger.ts`
- **Graph mailbox** — `src/triggers/graph-mailbox/graph-mailbox-trigger.ts`
- **SharePoint folder** — `src/triggers/sharepoint-folder/sharepoint-folder-trigger.ts`

The SharePoint trigger is the most thorough example — delta cursors, credential precedence, glob filtering, partial-upload handling.
