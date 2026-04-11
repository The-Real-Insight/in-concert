# Implementation

## MongoDB collections

The engine uses the following MongoDB collections. **MongoDB collection names** are PascalCase singular (e.g. `ProcessDefinition`); the `getCollections()` helper uses plural property names in code. Collections are created implicitly on first insert.

**Field-level schema, relationships, and event types:** [docs/database-schema.md](../docs/database-schema.md).

| Collection (MongoDB name) | Code accessor | Purpose |
|---------------------------|---------------|---------|
| `ProcessDefinition` | `ProcessDefinitions` | Deployed BPMN models in normalized graph form |
| `ProcessInstance` | `ProcessInstances` | Instance metadata (definition ref, status, timestamps) |
| `ProcessInstanceState` | `ProcessInstanceState` | Current execution projection (tokens, scopes, waits), versioned for optimistic concurrency (`_id` = instance id) |
| `ProcessInstanceEvent` | `ProcessInstanceEvents` | Append-only event store per instance |
| `ProcessInstanceHistory` | `ProcessInstanceHistory` | Audit trail (instance/task lifecycle) derived from events |
| `Continuation` | `Continuations` | Durable work units (START, TOKEN_AT_NODE, WORK_COMPLETED, etc.) |
| `Outbox` | `Outbox` | Pending callbacks for external delivery (CALLBACK_WORK, CALLBACK_DECISION, CALLBACK_EVENT, CALLBACK_MULTI_INSTANCE_RESOLVE) |
| `HumanTask` | `HumanTasks` | Worklist projection of USER_TASK work items (see [docs/sdk/usage.md](../docs/sdk/usage.md) Worklist reference) |

### Indexes

Indexes are created at startup via `ensureIndexes()` in `src/db/indexes.ts` (authoritative list in [docs/database-schema.md](../docs/database-schema.md)):

- **ProcessInstanceEvent**: `(instanceId, seq)` unique
- **Continuation**: `(status, dueAt)`, `(instanceId)`
- **Outbox**: `(status, nextAttemptAt)`
- **ProcessDefinition**: `(id, version)` unique
- **HumanTask**: `(status, assigneeUserId, createdAt)`, `(status, candidateRoles, createdAt)`, `(status, roleId, createdAt)`, `(status, assigneeUserId, roleId, createdAt)`, `(instanceId)`
- **ProcessInstanceHistory**: `(instanceId, seq)`
