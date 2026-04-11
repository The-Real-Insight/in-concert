# MongoDB database schema

This document is the **canonical description** of how the BPMN engine persists data in MongoDB: **collection names**, **document fields**, **types**, and **semantics**. It is maintained next to the repository design notes under `readme/`.

**Implementation source of truth:** TypeScript types and collection names in [`src/db/collections.ts`](../src/db/collections.ts); indexes in [`src/db/indexes.ts`](../src/db/indexes.ts). If this document disagrees with those files, **update this document** or fix the code—do not guess.

**User-facing overview** (getting started, SDK links): [`docs/database-schema.md`](../docs/database-schema.md).

---

## Connection and logical databases

| Field / setting | Type | Semantics |
|-----------------|------|-----------|
| `MONGO_URL` | string (URI) | MongoDB connection string. Default in code: `mongodb://localhost:27017/tri-bpmn-engine` (see [`src/config.ts`](../src/config.ts)). |
| `MONGO_BPM_DB` or `MONGO_DB` | string | **Logical database name** for all **engine** collections in this document. Default: `BPM`. |
| `MONGO_DB` (conversations) | string | Used as the **conversations** database by [`src/db/client.ts`](../src/db/client.ts) (`getConversationsDb`). Defaults to `BPM` when unset; conversation collections are **not** part of the engine schema below. |

Call **`ensureIndexes(db)`** once at startup on the BPM `Db` so workers and queries match the indexed fields below.

---

## Collections (overview)

MongoDB **collection names** are PascalCase **singular**. [`getCollections()`](../src/db/collections.ts) exposes them under plural **property** names in application code.

| MongoDB collection | Code property | Semantics |
|--------------------|---------------|-----------|
| `ProcessDefinition` | `ProcessDefinitions` | Deployed BPMN: normalized graph, versioning, optional XML. |
| `ProcessInstance` | `ProcessInstances` | One document per process **run** (metadata and lifecycle). |
| `ProcessInstanceState` | `ProcessInstanceState` | **Mutable execution projection** for that run; `_id` equals instance id. |
| `ProcessInstanceEvent` | `ProcessInstanceEvents` | **Append-only** event log per instance (`seq` monotonic per instance). |
| `ProcessInstanceHistory` | `ProcessInstanceHistory` | **Audit trail** rows derived from selected events (human-readable lifecycle). |
| `Continuation` | `Continuations` | **Work queue** for the continuation processor (START, token at node, work completed, …). |
| `Outbox` | `Outbox` | **Outbound callbacks** to integrators (work, decisions, events, multi-instance). |
| `HumanTask` | `HumanTasks` | **Worklist projection** for user tasks (OPEN / CLAIMED / COMPLETED / CANCELED). |

Collections are created on **first insert**. There is no separate migration beyond `ensureIndexes`.

---

## Identifiers and references

| Concept | Semantics |
|---------|-----------|
| Instance id | `ProcessInstance._id` — UUID string; same value as `ProcessInstanceState._id`. |
| Definition identity | Business uniqueness is **`(ProcessDefinition.id, ProcessDefinition.version)`** (unique index). Each deploy also has its own document `_id` (used as `definitionId` on instances depending on API). |
| Foreign keys | `instanceId` on events, continuations, outbox, history, and human tasks points at `ProcessInstance._id`. |
| Human task id | `HumanTask._id` typically matches the engine **work item id** for that user task. |

---

## `ProcessDefinition` collection

One document per **deployed** definition version.

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Primary key of this deployment document. |
| `id` | string | Business definition id (e.g. workflow id from the authoring system). |
| `tenantId` | string \| omitted | Optional tenant scope. |
| `name` | string | Human-readable definition name. |
| `version` | string | Version label (e.g. `"1"`, `"2.0"`); part of unique pair with `id`. |
| `bpmnXml` | string \| omitted | Optional stored BPMN 2.0 XML. |
| `graph` | object (`NormalizedGraph`) | Executable **normalized graph** (see [Normalized graph](#normalizedgraph-in-processdefinitiongraph)). |
| `createdAt` | Date | When this document was first created. |
| `deployedAt` | Date | When this version was deployed; used to resolve **latest** by `id`. |

### `NormalizedGraph` (in `ProcessDefinition.graph`)

| Field | Type | Semantics |
|-------|------|-----------|
| `processId` | string | Process identifier within the graph. |
| `nodes` | object | Map **node id →** [`NodeDef`](#nodedef). |
| `flows` | object | Map **flow id →** [`FlowDef`](#flowdef). |
| `startNodeIds` | string[] | BPMN start event node ids (entry points). |
| `metadata` | object | Precomputed adjacency and join helpers (see below). |

#### `metadata` (inside `NormalizedGraph`)

| Field | Type | Semantics |
|-------|------|-----------|
| `incomingByNode` | object | Maps each **node id** to an array of **incoming sequence flow ids**. |
| `outgoingByNode` | object | Maps each **node id** to an array of **outgoing sequence flow ids**. |
| `upstreamSetByOrJoinIncoming` | object \| omitted | Optional nested map for **OR-join** upstream token tracking. |

#### `NodeDef`

| Field | Type | Semantics |
|-------|------|-----------|
| `id` | string | BPMN element id. |
| `type` | string | BPMN type (e.g. `userTask`, `serviceTask`, `exclusiveGateway`). |
| `name` | string \| omitted | Display name. |
| `laneRef` | string \| omitted | Lane / pool reference for display. |
| `roleId` | string \| omitted | `tri:roleId` from pool/lane for worklist / ACL. |
| `incoming` | string[] | Incoming flow ids. |
| `outgoing` | string[] | Outgoing flow ids. |
| `attachedToRef` | string \| omitted | For boundary events: host activity id. |
| `timerDefinition` | string \| omitted | Timer expression / definition when applicable. |
| `messageRef` | string \| omitted | Message definition reference when applicable. |
| `eventDefinition` | string \| omitted | Event definition reference when applicable. |

#### `FlowDef`

| Field | Type | Semantics |
|-------|------|-----------|
| `id` | string | Sequence flow id. |
| `sourceRef` | string | Source node id. |
| `targetRef` | string | Target node id. |
| `name` | string \| omitted | Flow label (e.g. gateway outcome). |

---

## `ProcessInstance` collection

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Instance id (UUID). |
| `definitionId` | string | Reference to deployed definition (typically definition document `_id`). |
| `conversationId` | string \| omitted | Optional link to an external conversation. |
| `tenantId` | string \| omitted | Optional tenant. |
| `rootInstanceId` | string | Root instance in a hierarchy; equals `_id` for top-level instances. |
| `parentInstanceId` | string \| omitted | Parent instance when nested (subprocess / call activity). |
| `parentCallActivityId` | string \| omitted | Call activity node id when this instance represents a called subprocess. |
| `businessKey` | string \| omitted | Correlation key for external systems. |
| `status` | enum | `RUNNING` \| `COMPLETED` \| `TERMINATED` \| `FAILED`. |
| `createdAt` | Date | When the instance was started. |
| `endedAt` | Date \| omitted | Set when the instance reaches a terminal state. |
| `startedBy` | string \| omitted | Actor id (e.g. email) who started the instance. |
| `startedByDetails` | object \| omitted | [`UserDetails`](#userdetails). |
| `updatedAt` | Date \| omitted | May be set by the runtime on some update paths (e.g. completion); not always present on older documents. |

---

## `UserDetails`

Embedded in instance and task documents.

| Field | Type | Semantics |
|-------|------|-----------|
| `email` | string | Primary user identifier in practice. |
| `firstName` | string \| omitted | |
| `lastName` | string \| omitted | |
| `phone` | string \| omitted | |
| `photoUrl` | string \| omitted | |

---

## `ProcessInstanceState` collection

Single document per instance; **`_id`** equals the instance id. Holds the **executable snapshot** updated transactionally with new events.

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Same as `ProcessInstance._id`. |
| `version` | number | **Optimistic concurrency** version; incremented on each successful transition. |
| `status` | enum | `RUNNING` \| `COMPLETED` \| `TERMINATED` \| `FAILED` — mirrors run status. |
| `tokens` | array of [`Token`](#token) | All tokens (active, waiting, consumed) for this instance. |
| `scopes` | array of [`Scope`](#scope) | ROOT and SUBPROCESS scopes. |
| `waits` | object | Aggregate of open **work items**, **message subscriptions**, **timers**, **pending decisions** (see below). |
| `dedupe` | object | Idempotency caps (see [`dedupe`](#dedupe-in-processinstancestate)). |
| `lastEventSeq` | number | Last event sequence number applied to this instance. |
| `updatedAt` | Date | Last state write time. |
| `joinArrivals` | object \| omitted | Nested map: join node → scope → flow → token id for **parallel join** synchronization. |
| `multiInstancePending` | object \| omitted | Map **key** `nodeId-scopeId` → progress for **multi-instance** activities (totals and completion count). |

### `waits` (inside `ProcessInstanceState`)

| Field | Type | Semantics |
|-------|------|-----------|
| `workItems` | array of [`WorkItemRef`](#workitemref) | Open service/user/call-activity work items. |
| `messageSubs` | array of [`MessageSubRef`](#messagesubref) | Active message catch / correlation subscriptions. |
| `timers` | array of [`TimerRef`](#timerref) | Scheduled timers (including boundary). |
| `decisions` | array of [`PendingDecisionRef`](#pendingdecisionref) | Gateways waiting for external or asynchronous decisions. |

### `dedupe` (inside `ProcessInstanceState`)

| Field | Type | Semantics |
|-------|------|-----------|
| `processedCommandIds` | string[] | Recent command ids already applied (bounded). |
| `completedWorkItemIds` | string[] | Recent completed work item ids (bounded). |
| `processedMessageIds` | string[] | Recent message delivery ids (bounded). |
| `recordedDecisionIds` | string[] | Recent decision ids (bounded). |

### `Token`

| Field | Type | Semantics |
|-------|------|-----------|
| `tokenId` | string | Unique token id. |
| `nodeId` | string | BPMN node where the token is positioned. |
| `scopeId` | string | Scope containing this token. |
| `status` | enum | `ACTIVE` \| `WAITING` \| `CONSUMED`. |
| `createdAt` | Date | When the token was created. |
| `activation` | object \| omitted | For OR-split: `{ orSplitId: string }`. |

### `Scope`

| Field | Type | Semantics |
|-------|------|-----------|
| `scopeId` | string | Unique scope id. |
| `kind` | enum | `ROOT` \| `SUBPROCESS`. |
| `nodeId` | string \| omitted | For subprocess scope: call activity / subprocess node id. |
| `parentScopeId` | string \| omitted | Parent scope id when nested. |

### `WorkItemRef`

| Field | Type | Semantics |
|-------|------|-----------|
| `workItemId` | string | Stable id for this work item (used in APIs and callbacks). |
| `nodeId` | string | BPMN activity id. |
| `tokenId` | string | Token this work item belongs to. |
| `scopeId` | string | Scope id. |
| `kind` | enum | `SERVICE_TASK` \| `USER_TASK` \| `CALL_ACTIVITY`. |
| `status` | enum | `OPEN` \| `COMPLETED` \| `FAILED` \| `CANCELED`. |
| `createdAt` | Date | When the work item was created. |
| `correlationHints` | object \| omitted | Arbitrary JSON hints for integration. |
| `executionIndex` | number \| omitted | Multi-instance: 0-based index of this iteration. |
| `multiInstanceKey` | string \| omitted | Multi-instance: correlates iterations (`nodeId-scopeId`). |

### `MessageSubRef`

| Field | Type | Semantics |
|-------|------|-----------|
| `subscriptionId` | string | Unique subscription id. |
| `messageName` | string | BPMN message name. |
| `nodeId` | string | Catching node id. |
| `tokenId` | string | Associated token. |
| `scopeId` | string | Scope id. |
| `correlationKeys` | object \| omitted | Key/value correlation for the message. |
| `createdAt` | Date | Subscription creation time. |

### `TimerRef`

| Field | Type | Semantics |
|-------|------|-----------|
| `timerId` | string | Unique timer id. |
| `nodeId` | string | Timer event node id. |
| `tokenId` | string | Associated token. |
| `scopeId` | string | Scope id. |
| `dueAt` | Date | When the timer fires. |
| `isBoundary` | boolean | True if boundary timer. |
| `boundary` | object \| omitted | If boundary: `{ attachedToNodeId, interrupting }`. |
| `createdAt` | Date | When the timer was scheduled. |

### `PendingDecisionRef`

| Field | Type | Semantics |
|-------|------|-----------|
| `decisionId` | string | Unique decision id (used in callbacks and API). |
| `kind` | enum | `XOR_SPLIT` \| `OR_SPLIT` \| `EVENT_BASED_ARM` \| `CORRELATION_KEYS`. |
| `nodeId` | string | Gateway (or decision) node id. |
| `tokenId` | string | Token waiting for the decision. |
| `scopeId` | string | Scope id. |
| `optionsHash` | string | Hash of option set for consistency checks. |
| `contextRef` | string \| omitted | Optional opaque context reference. |
| `createdAt` | Date | When the decision was requested. |

### `multiInstancePending` entry value

| Field | Type | Semantics |
|-------|------|-----------|
| `nodeId` | string | Multi-instance activity node id. |
| `scopeId` | string | Scope id. |
| `parentTokenId` | string | Parent token driving the multi-instance. |
| `totalItems` | number | Expected number of iterations. |
| `completedCount` | number | How many iterations have completed. |

---

## `ProcessInstanceEvent` collection

Append-only **domain events** for replay and integration.

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Assigned on insert (e.g. UUID). |
| `instanceId` | string | Owning instance. |
| `seq` | number | Monotonically increasing **per instance**; unique with `instanceId`. |
| `type` | string | Event type name (see [Event types](#processinstanceevent-types)). |
| `at` | Date | Event timestamp. |
| `payload` | object | Type-specific JSON payload. |

### `ProcessInstanceEvent` types

Emitted by the transition engine (representative set; `type` is an open string in types):

| `type` | Semantics |
|--------|-----------|
| `INSTANCE_CREATED` | Run started; feeds history as instance started. |
| `INSTANCE_COMPLETED` | Run completed successfully. |
| `SCOPE_CREATED` | New scope (ROOT or SUBPROCESS). |
| `SCOPE_ENDED` | Scope closed. |
| `TOKEN_CREATED` | New token placed on a node. |
| `TOKEN_CONSUMED` | Token consumed (single or batch in payload). |
| `NODE_ENTERED` | Token entered a node. |
| `WORK_ITEM_CREATED` | Service/user work opened. |
| `WORK_ITEM_COMPLETED` | Work item finished. |
| `DECISION_REQUESTED` | Gateway needs a decision (often paired with outbox `CALLBACK_DECISION`). |
| `DECISION_RECORDED` | Gateway decision applied. |

Some **SDK / projection** code also handles `INSTANCE_TERMINATED` and `INSTANCE_FAILED`; presence in stored events depends on version and code paths. See [REQUIREMENTS.md](./REQUIREMENTS.md) for product-level expectations.

---

## `ProcessInstanceHistory` collection

Denormalized **audit** rows built when processing transitions (not a second event log).

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Row id. |
| `instanceId` | string | Instance this row belongs to. |
| `seq` | number | Aligns with the source event `seq` where applicable. |
| `eventType` | enum | `INSTANCE_STARTED` \| `TASK_STARTED` \| `TASK_COMPLETED`. |
| `at` | Date | When the logical event occurred. |
| `createdAt` | Date | When this history row was written. |
| `startedBy` | string \| omitted | For `INSTANCE_STARTED`: who started the instance. |
| `startedByDetails` | object \| omitted | For `INSTANCE_STARTED`: [`UserDetails`](#userdetails). |
| `nodeId` | string \| omitted | For task rows: BPMN node id. |
| `nodeName` | string \| omitted | For task rows: display name. |
| `nodeType` | enum \| omitted | For task rows: `userTask` \| `serviceTask`. |
| `workItemId` | string \| omitted | For task rows: work item id. |
| `scopeId` | string \| omitted | For task rows: scope id. |
| `completedBy` | string \| omitted | For `TASK_COMPLETED`: completer id. |
| `completedByDetails` | object \| omitted | For `TASK_COMPLETED`: [`UserDetails`](#userdetails). |
| `result` | any \| omitted | For `TASK_COMPLETED`: completion payload. |

---

## `Continuation` collection

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Continuation id. |
| `instanceId` | string | Instance to advance. |
| `dueAt` | Date | Scheduling time (ordering with status for workers). |
| `kind` | enum | `START` \| `TOKEN_AT_NODE` \| `TIMER_DUE` \| `MESSAGE` \| `WORK_COMPLETED` \| `DECISION_RECORDED` \| `MULTI_INSTANCE_RESOLVED`. |
| `payload` | object | Kind-specific (e.g. `commandId`, `workItemId`, flow ids). |
| `status` | enum | `READY` \| `IN_PROGRESS` \| `DONE` \| `DEAD`. |
| `ownerId` | string \| omitted | Worker id holding a lease. |
| `leaseUntil` | Date \| omitted | Lease expiry. |
| `attempts` | number | Number of processing attempts. |
| `dedupeKey` | string \| omitted | Optional deduplication key. |
| `createdAt` | Date | Insert time. |
| `updatedAt` | Date | Last update time. |

---

## `Outbox` collection

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Outbox message id. |
| `instanceId` | string | Instance that produced the callback. |
| `rootInstanceId` | string | Root instance id (for nested runs). |
| `kind` | enum | `CALLBACK_WORK` \| `CALLBACK_DECISION` \| `CALLBACK_EVENT` \| `CALLBACK_MULTI_INSTANCE_RESOLVE`. |
| `destination` | object | `{ url: string, headers?: Record<string, string> }` — target for HTTP delivery; `url` may be empty for in-process delivery. |
| `payload` | object | Callback body (work item, decision request, etc.). |
| `status` | enum | `READY` \| `SENT` \| `RETRY` \| `DEAD`. |
| `attempts` | number | Delivery attempts. |
| `nextAttemptAt` | Date | Next retry or delivery time. |
| `lastError` | string \| omitted | Last delivery error message. |
| `idempotencyKey` | string | Idempotency for consumers. |
| `createdAt` | Date | Insert time. |
| `updatedAt` | Date | Last update time. |

Application-level callback shapes are described in [`docs/sdk/usage.md`](../docs/sdk/usage.md).

---

## `HumanTask` collection

| Field | Type | Semantics |
|-------|------|-----------|
| `_id` | string | Typically equals engine **work item id** for user tasks. |
| `instanceId` | string | Owning instance. |
| `conversationId` | string \| omitted | Optional conversation link. |
| `definitionId` | string \| omitted | Optional definition reference. |
| `nodeId` | string | BPMN user task node id. |
| `name` | string | Task name for UI. |
| `role` | string \| omitted | Lane / pool display name from BPMN. |
| `roleId` | string \| omitted | `tri:roleId` for role-based queries. |
| `status` | enum | `OPEN` \| `CLAIMED` \| `COMPLETED` \| `CANCELED`. |
| `assigneeUserId` | string \| omitted | User id when claimed or assigned. |
| `candidateRoles` | string[] \| omitted | Lane names (legacy / display). |
| `candidateRoleIds` | string[] \| omitted | Role ids for candidate filtering. |
| `createdAt` | Date | Task appearance time. |
| `claimedAt` | Date \| omitted | When claimed. |
| `completedAt` | Date \| omitted | When completed. |
| `canceledAt` | Date \| omitted | When canceled. |
| `completedBy` | string \| omitted | Completer id. |
| `completedByDetails` | object \| omitted | [`UserDetails`](#userdetails). |
| `result` | any \| omitted | Completion payload. |
| `version` | number | Optimistic concurrency for updates. |

---

## Indexes

Created by **`ensureIndexes(db)`** in [`src/db/indexes.ts`](../src/db/indexes.ts).

| Collection | Index keys | Type | Semantics |
|------------|------------|------|-----------|
| `ProcessInstanceEvent` | `instanceId` ascending, `seq` ascending | **unique** | Guarantees ordered, non-colliding event stream per instance. |
| `Continuation` | `status` ascending, `dueAt` ascending | non-unique | Worker claims **ready** work in due order. |
| `Continuation` | `instanceId` ascending | non-unique | Look up continuations for an instance. |
| `Outbox` | `status` ascending, `nextAttemptAt` ascending | non-unique | Delivery / retry scheduling. |
| `ProcessDefinition` | `id` ascending, `version` ascending | **unique** | One deployment per business id + version. |
| `HumanTask` | `status`, `assigneeUserId`, `createdAt` (desc) | non-unique | List tasks for assignee. |
| `HumanTask` | `status`, `candidateRoles`, `createdAt` (desc) | non-unique | List by candidate lane names. |
| `HumanTask` | `status`, `roleId`, `createdAt` (desc) | non-unique | List by lane role id. |
| `HumanTask` | `status`, `assigneeUserId`, `roleId`, `createdAt` (desc) | non-unique | Combined assignee + role listing. |
| `HumanTask` | `instanceId` ascending | non-unique | Tasks for one instance. |
| `ProcessInstanceHistory` | `instanceId` ascending, `seq` ascending | non-unique | Ordered history reads per instance. |

---

## Related documents

| Document | Role |
|----------|------|
| [`docs/database-schema.md`](../docs/database-schema.md) | Short hub + links from the main docs tree. |
| [`docs/getting-started.md`](../docs/getting-started.md) | Environment variables and running the stack. |
| [`REQUIREMENTS.md`](./REQUIREMENTS.md) | Product requirements and BPMN subset. |
| [`TEST.md`](./TEST.md) | Conformance scenario matrix. |
