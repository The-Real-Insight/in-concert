# Worklist Layer Specification

## Purpose

The Worklist Layer provides the human interaction perspective for the tri-bpmn-engine.

It:

- Projects USER_TASK work items from the engine
- Persists them independently
- Supports user and role-based worklists
- Handles claim / unclaim semantics
- Delegates completion to the engine
- Remains eventually consistent with the engine

The engine remains the authoritative source of execution truth.

---

# Architecture

## Components

1. Engine Service (existing)
   - Owns process state
   - Emits CALLBACK_WORK and lifecycle events

2. Worklist Service (new)
   - Maintains human task projection
   - Provides worklist APIs
   - Delegates task completion to engine

3. SDK Facade
   - Exposes unified API
   - Internally routes to engine + worklist services

---

# Consistency Model

- Engine is authoritative for execution state.
- Worklist is a projection of engine work items.
- Worklist is eventually consistent.
- Completion is validated by engine.
- Engine 409 responses must be propagated.

---

# Data Model

Collection: human_tasks

## Schema

```typescript
interface HumanTask {
  _id: string;                  // workItemId (natural key)
  instanceId: string;
  definitionId?: string;
  nodeId: string;

  name: string;                 // BPMN task name
  role?: string;                // BPMN lane name

  status: 'OPEN' | 'CLAIMED' | 'COMPLETED' | 'CANCELED';

  assigneeUserId?: string;
  candidateRoles?: string[];

  createdAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
  canceledAt?: Date;

  result?: unknown;

  version: number;              // optimistic lock for task record
}
```

## Indexes

```text
{ status: 1, assigneeUserId: 1, createdAt: -1 }
{ status: 1, candidateRoles: 1, createdAt: -1 }
{ instanceId: 1 }
```

---

# Event Projection Rules

Worklist Service subscribes to engine callback stream.

## On CALLBACK_WORK (kind = userTask)

Upsert human_tasks:

- _id = workItemId
- status = OPEN
- name = payload.name
- role = payload.lane
- candidateRoles = [payload.lane] if defined
- createdAt = now
- version = 1

Idempotent via _id.

---

## On WORK_ITEM_COMPLETED (engine event)

- Set status = COMPLETED
- completedAt = now

---

## On WORK_ITEM_CANCELED

- Set status = CANCELED
- canceledAt = now

---

## On INSTANCE_TERMINATED

- All OPEN or CLAIMED tasks for instance → CANCELED

---

# Worklist Service API

Base path: /v1/tasks

All mutating endpoints require commandId (UUID).

---

## List Tasks

### GET /v1/tasks

Query params:

- assigneeUserId?
- candidateRole?
- status? (default OPEN)
- instanceId?
- limit?
- cursor?

Returns:

```typescript
{
  items: HumanTask[];
  nextCursor?: string;
}
```

Rules:

- If assigneeUserId provided → filter by assigneeUserId
- If candidateRole provided → filter candidateRoles
- If both provided → AND filter

---

## Get Single Task

### GET /v1/tasks/{taskId}

Returns HumanTask or 404.

---

## Activate Task

### POST /v1/tasks/{taskId}/activate

Body:

```typescript
{
  commandId: string;
  userId: string;
}
```

Activates a user task for a user. The state change (OPEN → CLAIMED) prohibits other users from activating the same task.

Rules:

- Task must exist.
- status must be OPEN.
- Atomic update:
  findOneAndUpdate(
    { _id: taskId, status: 'OPEN' },
    { $set: { status: 'CLAIMED', assigneeUserId: userId, claimedAt: now }, $inc: { version: 1 } }
  )

Responses:

- 200 → activated (returns updated HumanTask)
- 409 → already activated by another user or not OPEN
- 404 → not found

---

## Claim Task

### POST /v1/tasks/{taskId}/claim

Same semantics as activate: OPEN → CLAIMED with assigneeUserId. Use claim or activate per domain preference.

---

## Unclaim Task

### POST /v1/tasks/{taskId}/unclaim

Body:

```typescript
{
  commandId: string;
  userId: string;
}
```

Rules:

- status must be CLAIMED
- assigneeUserId must match
- Set status back to OPEN
- Remove assigneeUserId
- version++

---

## Complete Task

### POST /v1/tasks/{taskId}/complete

Body:

```typescript
{
  commandId: string;
  userId: string;
  result?: unknown;
}
```

Execution:

1. Load task.
2. Validate:
   - status is OPEN or CLAIMED
   - if CLAIMED → userId must match
3. Call engine:

   engine.completeWorkItem(instanceId, taskId, { commandId, result })

4. If engine returns success:
   - mark task COMPLETED
   - set completedAt
   - store result
   - version++

5. If engine returns 409:
   - mark task CANCELED
   - return 409

Responses:

- 202 → accepted
- 409 → stale (engine rejected)
- 404 → not found

Engine remains source of truth.

---

# SDK Facade

Single client:

```typescript
const sdk = new TriSdk({
  engine: { mode: 'rest', baseUrl: 'http://engine:3000' },
  tasks:  { baseUrl: 'http://tasks:3001' }
});
```

## SDK Surface

```typescript
sdk.engine.deploy(...)
sdk.engine.startInstance(...)
sdk.engine.submitDecision(...)

sdk.tasks.list(...)
sdk.tasks.get(taskId)
sdk.tasks.claim(taskId, { userId })
sdk.tasks.activate(taskId, { userId })
sdk.tasks.unclaim(taskId, { userId })
sdk.tasks.complete(taskId, { userId, result })
```

Completion internally calls Worklist Service only.
Worklist Service delegates to engine.

---

# Local Mode (Monolith Dev Mode)

In local mode:

- Worklist Service shares same MongoDB.
- Engine callback subscription runs in same process.
- No network calls between engine and tasks.
- SDK routes internally.

---

# Failure Handling

## Boundary Timer Cancels Task

Flow:

1. Engine emits WORK_ITEM_CANCELED
2. Projection marks task CANCELED
3. If user attempts complete:
   - engine returns 409
   - worklist returns 409

---

## Duplicate Callback Delivery

Safe due to _id = workItemId upsert.

---

## Double Completion Click

Engine idempotency ensures no duplicate execution.
Worklist status update must be idempotent.

---

# Scaling

## Engine

- Partition by instanceId
- Continuation workers scale horizontally

## Worklist

- Read-heavy
- Can scale independently
- May use read replicas

## Separation Benefit

Heavy worklist queries never touch engine collections.

---

# Security Model (Optional)

Worklist layer should enforce:

- Role-based filtering
- Claim authorization
- Tenant isolation
- Audit logging (who claimed/completed)

Engine does not enforce user-level permissions.

---

# Lifecycle Summary

Token reaches USER_TASK
    ↓
Engine creates workItem
    ↓
Engine emits CALLBACK_WORK
    ↓
Worklist projects task → status OPEN
    ↓
User claims task
    ↓
User completes task
    ↓
Worklist calls engine.completeWorkItem()
    ↓
Engine resumes execution
    ↓
Worklist marks COMPLETED
