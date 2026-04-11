# Database schema (MongoDB)

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

This page describes **how the engine stores data in MongoDB**: database selection, collection names, document shapes, and indexes. It reflects the TypeScript types in [`src/db/collections.ts`](../src/db/collections.ts) and index definitions in [`src/db/indexes.ts`](../src/db/indexes.ts). If the code and this doc disagree, **trust the source files**.

## Connection and databases

| Setting | Env vars | Default | Role |
|--------|----------|---------|------|
| MongoDB URI | `MONGO_URL` | `mongodb://localhost:27017/tri-bpmn-engine` | Server address (path segment is legacy/default DB name; the app selects logical DBs below). |
| BPM / engine data | `MONGO_BPM_DB` or `MONGO_DB` | `BPM` | Database holding **all collections in this document** (definitions, instances, events, work queue, outbox, worklist projection, history). |
| Conversations (demo / integrations) | `MONGO_DB` | `BPM` | Separate logical use: **conversation** data for the demo server; not part of the core engine schema below. See [`src/db/client.ts`](../src/db/client.ts). |

After obtaining a `Db` for the BPM database, call **`ensureIndexes(db)`** once at startup (see [`src/db/indexes.ts`](../src/db/indexes.ts)) so queries and workers behave correctly.

## Collections overview

MongoDB **collection names** are PascalCase singular (e.g. `ProcessDefinition`). The `getCollections()` helper exposes them with slightly different **property names** (often plural) for readability in code.

| MongoDB collection | Code accessor (`getCollections`) | Purpose |
|--------------------|----------------------------------|---------|
| `ProcessDefinition` | `ProcessDefinitions` | Deployed BPMN as normalized graph + metadata. |
| `ProcessInstance` | `ProcessInstances` | Per-run metadata (definition ref, status, timestamps). |
| `ProcessInstanceState` | `ProcessInstanceState` | **Mutable projection**: tokens, scopes, waits, versioning for optimistic concurrency. Document `_id` equals **instance id**. |
| `ProcessInstanceEvent` | `ProcessInstanceEvents` | **Append-only** event log per instance; monotonic `seq`. |
| `ProcessInstanceHistory` | `ProcessInstanceHistory` | Denormalized **audit trail** derived from selected events (task/instance lifecycle). |
| `Continuation` | `Continuations` | Durable work units for the processor (START, TOKEN_AT_NODE, WORK_COMPLETED, …). |
| `Outbox` | `Outbox` | Pending **callbacks** to external consumers (WebSocket / HTTP delivery, local handlers). |
| `HumanTask` | `HumanTasks` | **Worklist projection** for user tasks (updated from engine callbacks / stream). |

Collections are created on **first insert**; there is no separate schema migration step beyond `ensureIndexes`.

## Keys and relationships

- **`ProcessInstance._id`**: unique instance id (UUID).  
- **`ProcessInstanceState._id`**: same value as the instance id (one state document per instance).  
- **`ProcessInstanceEvent.instanceId`** / **`Continuation.instanceId`** / **`Outbox.instanceId`**: reference the instance.  
- **`ProcessDefinition`**: uniqueness in the business sense is **`(id, version)`** (see index below). Deployed documents also have their own **`_id`**.  
- **`HumanTask._id`**: typically aligns with **work item id** for user tasks (see [usage — worklist](sdk/usage.md)).

## `ProcessDefinition`

Deployed process model.

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | Document id. |
| `id` | string | Business definition id (e.g. model id). |
| `tenantId` | string? | Optional tenant. |
| `name` | string | Display name. |
| `version` | string | Version label (e.g. `"1"`, `"2.0"`). |
| `bpmnXml` | string? | Optional stored XML. |
| `graph` | object | **Normalized graph**: `processId`, `nodes`, `flows`, `startNodeIds`, `metadata` (adjacency, etc.). |
| `createdAt` | Date | Creation time. |
| `deployedAt` | Date | Used when resolving **latest** deployment for an `id`. |

## `ProcessInstance`

One row per process run.

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | Instance id. |
| `definitionId` | string | References deployed definition (resolution depends on API; usually definition document `_id`). |
| `conversationId` | string? | Optional link to external conversation. |
| `tenantId` | string? | Optional. |
| `rootInstanceId` | string | Root of hierarchy (same as `_id` for top-level). |
| `parentInstanceId` | string? | For subprocess / call-activity nesting. |
| `parentCallActivityId` | string? | Parent call activity node reference when nested. |
| `businessKey` | string? | Optional external correlation key. |
| `status` | enum | `RUNNING` \| `COMPLETED` \| `TERMINATED` \| `FAILED`. |
| `createdAt` | Date | |
| `endedAt` | Date? | Set when terminal. |
| `startedBy` | string? | e.g. user email. |
| `startedByDetails` | object? | `email`, optional `firstName`, `lastName`, `phone`, `photoUrl`. |

## `ProcessInstanceState`

Authoritative **execution snapshot** for the instance. Updated in the same transactional batch as new events and continuations (see [`src/workers/processor.ts`](../src/workers/processor.ts)).

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | Instance id. |
| `version` | number | Incremented on each successful transition; used for **optimistic locking**. |
| `status` | enum | Mirrors instance run status. |
| `tokens` | array | Active/waiting/consumed **tokens** (`tokenId`, `nodeId`, `scopeId`, `status`, `createdAt`, optional `activation` for OR-split). |
| `scopes` | array | **Scopes** (`ROOT`, `SUBPROCESS`, parent links). |
| `waits` | object | `workItems`, `messageSubs`, `timers`, `decisions` — pending external input / time / correlation. |
| `dedupe` | object | Bounded lists: processed command ids, completed work items, messages, decisions (idempotency). |
| `lastEventSeq` | number | Highest event sequence applied. |
| `updatedAt` | Date | |
| `joinArrivals` | object? | Parallel join tracking (nested maps). |
| `multiInstancePending` | object? | Per multi-instance activity completion counts. |

Nested types (`Token`, `WorkItemRef`, `MessageSubRef`, `TimerRef`, `PendingDecisionRef`) are defined alongside `ProcessInstanceStateDoc` in [`src/db/collections.ts`](../src/db/collections.ts).

## `ProcessInstanceEvent`

Append-only **event sourcing** stream.

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | Assigned on insert (UUID). |
| `instanceId` | string | |
| `seq` | number | Monotonic per instance; **unique** with `instanceId`. |
| `type` | string | Event type (see [Event types](#event-types) below). |
| `at` | Date | Event time. |
| `payload` | object | Type-specific JSON payload. |

## `ProcessInstanceHistory`

Human-readable **audit** rows, derived when the processor applies transitions (see [`src/history/service.ts`](../src/history/service.ts)).

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | |
| `instanceId` | string | |
| `seq` | number | Aligns with source event `seq` where applicable. |
| `eventType` | enum | `INSTANCE_STARTED` \| `TASK_STARTED` \| `TASK_COMPLETED`. |
| `at` | Date | |
| `nodeId`, `nodeName`, `nodeType`, `workItemId`, `scopeId` | optional | Task-related. |
| `startedBy`, `startedByDetails` | optional | For instance started. |
| `completedBy`, `completedByDetails`, `result` | optional | For task completed. |
| `createdAt` | Date | Insert time of history row. |

## `Continuation`

Work queue for the **continuation processor** (`READY` → claimed → processed).

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | |
| `instanceId` | string | |
| `dueAt` | Date | Scheduling / ordering. |
| `kind` | enum | `START`, `TOKEN_AT_NODE`, `TIMER_DUE`, `MESSAGE`, `WORK_COMPLETED`, `DECISION_RECORDED`, `MULTI_INSTANCE_RESOLVED`. |
| `payload` | object | Kind-specific (e.g. `workItemId`, `commandId`, flow ids). |
| `status` | enum | `READY`, `IN_PROGRESS`, `DONE`, `DEAD`. |
| `ownerId` | string? | Worker lease identity. |
| `leaseUntil` | Date? | Lease expiry. |
| `attempts` | number | Retry count. |
| `dedupeKey` | string? | Optional deduplication. |
| `createdAt` / `updatedAt` | Date | |

## `Outbox`

Rows represent **outbound callbacks** (work, decisions, events, multi-instance resolve). Delivery layer marks them `SENT` or retries.

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | |
| `instanceId` | string | |
| `rootInstanceId` | string | For correlation across nested instances. |
| `kind` | enum | `CALLBACK_WORK`, `CALLBACK_DECISION`, `CALLBACK_EVENT`, `CALLBACK_MULTI_INSTANCE_RESOLVE`. |
| `destination` | object | `url`, optional `headers` (may be empty for in-process delivery). |
| `payload` | object | Callback body (work item metadata, decision request, etc.). |
| `status` | enum | `READY`, `SENT`, `RETRY`, `DEAD`. |
| `attempts` | number | |
| `nextAttemptAt` | Date | For retry scheduling. |
| `lastError` | string? | |
| `idempotencyKey` | string | |
| `createdAt` / `updatedAt` | Date | |

Callback shapes from an application perspective are documented in the [SDK usage guide](sdk/usage.md).

## `HumanTask`

**Worklist** projection for user tasks. Fields support claim/complete flows and role-based listing.

| Field | Type | Notes |
|-------|------|--------|
| `_id` | string | |
| `instanceId` | string | |
| `conversationId` | string? | |
| `definitionId` | string? | |
| `nodeId` | string | BPMN node id. |
| `name` | string | Task name. |
| `role` | string? | Lane / pool display name. |
| `roleId` | string? | `tri:roleId` for access control. |
| `status` | enum | `OPEN`, `CLAIMED`, `COMPLETED`, `CANCELED`. |
| `assigneeUserId` | string? | |
| `candidateRoles` | string[]? | Lane names (legacy / display). |
| `candidateRoleIds` | string[]? | Role ids for filtering. |
| `createdAt` | Date | |
| `claimedAt` / `completedAt` / `canceledAt` | Date? | |
| `completedBy` | string? | |
| `completedByDetails` | object? | Same shape as instance `startedByDetails`. |
| `result` | unknown? | Completion payload. |
| `version` | number | Optimistic concurrency for task updates. |

## Indexes

Created by **`ensureIndexes(db)`** in [`src/db/indexes.ts`](../src/db/indexes.ts):

| Collection | Index | Options |
|------------|--------|---------|
| `ProcessInstanceEvent` | `{ instanceId: 1, seq: 1 }` | **unique** |
| `Continuation` | `{ status: 1, dueAt: 1 }` | |
| `Continuation` | `{ instanceId: 1 }` | |
| `Outbox` | `{ status: 1, nextAttemptAt: 1 }` | |
| `ProcessDefinition` | `{ id: 1, version: 1 }` | **unique** |
| `HumanTask` | `{ status: 1, assigneeUserId: 1, createdAt: -1 }` | |
| `HumanTask` | `{ status: 1, candidateRoles: 1, createdAt: -1 }` | |
| `HumanTask` | `{ status: 1, roleId: 1, createdAt: -1 }` | |
| `HumanTask` | `{ status: 1, assigneeUserId: 1, roleId: 1, createdAt: -1 }` | |
| `HumanTask` | `{ instanceId: 1 }` | |
| `ProcessInstanceHistory` | `{ instanceId: 1, seq: 1 }` | for ordered reads by instance |

## Event types

`ProcessInstanceEvent.type` is an open string in the type system; in practice the transition engine emits types such as:

| `type` (examples) | Role |
|-------------------|------|
| `INSTANCE_CREATED` | Instance started; seeds history as `INSTANCE_STARTED`. |
| `INSTANCE_COMPLETED` | Normal completion. |
| `SCOPE_CREATED` / `SCOPE_ENDED` | Scope lifecycle. |
| `TOKEN_CREATED` / `TOKEN_CONSUMED` | Token flow. |
| `NODE_ENTERED` | Token reached a node. |
| `WORK_ITEM_CREATED` / `WORK_ITEM_COMPLETED` | Service/user work items; history maps to task started/completed. |
| `DECISION_REQUESTED` / `DECISION_RECORDED` | Gateway decision flow. |

Some **client and projection** code also references `INSTANCE_TERMINATED` and `INSTANCE_FAILED` for terminal handling; whether those event strings appear in your database depends on engine version and code paths. For intended behavior across failures and termination, see [requirements](../readme/REQUIREMENTS.md).

## Related documentation

- [Getting started](getting-started.md) — environment variables and running MongoDB.  
- [SDK usage — local mode](sdk/usage.md) — `connectDb`, `ensureIndexes`, embedding the engine.  
- [Implementation notes (collections summary)](../readme/IMPLEMENTATION.md) — short table; this page is the detailed reference.  
- [Requirements](../readme/REQUIREMENTS.md) — persistence and event expectations at the product level.
