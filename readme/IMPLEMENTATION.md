# Implementation

## MongoDB Collections

The engine uses the following MongoDB collections. Collections are created implicitly on first insert. Naming follows camelCase with uppercase first letter (per requirements).

| Collection | Purpose |
|------------|---------|
| **ProcessDefinitions** | Deployed BPMN models in normalized graph form |
| **ProcessInstances** | Instance metadata (definition ref, status, timestamps) |
| **ProcessInstanceState** | Current execution projection (tokens, scopes, waits), versioned for optimistic concurrency |
| **ProcessInstanceEvents** | Append-only event store per instance |
| **Continuations** | Durable work units (START, TOKEN_AT_NODE, WORK_COMPLETED, etc.) |
| **Outbox** | Pending callbacks for external delivery (CALLBACK_WORK, CALLBACK_DECISION, CALLBACK_EVENT) |

### Indexes

Indexes are created at startup via `ensureIndexes()` in `src/db/indexes.ts`:

- **ProcessInstanceEvents**: `(instanceId, seq)` unique
- **Continuations**: `(status, dueAt)`, `(instanceId)`
- **Outbox**: `(status, nextAttemptAt)`
- **ProcessDefinitions**: `(name, version)` unique
