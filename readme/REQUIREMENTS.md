# Requirements

## Scope, Goals, Non-Goals

### Purpose

This engine executes a defined BPMN 2.0 subset with strong reliability guarantees.
Business variables and decision logic are externalized.
The engine focuses exclusively on scalable, deterministic execution.

### Goals

- Execute BPMN token flow correctly.
- Event-sourced instance history.
- Optimistic concurrency (single-writer per instance).
- Horizontal scalability with stateless workers.
- At-least-once external callbacks (via outbox).
- Deterministic replay: decisions are recorded and never re-evaluated during replay.
- External decision evaluation via callback at gateway conditions.

### Non-Goals

- Full BPMN 2.0 coverage.
- Managing business variables internally.
- AI/LLM evaluation inside the engine.
- Human task UI/worklists.
- Exactly-once delivery to external systems.

## Supported BPMN Subset

### Events

- Start Event (none)
- End Event (none)
- Intermediate Catch Timer
- Boundary Timer (interrupting and non-interrupting)
- Boundary Error (interrupting and non-interrupting)
- Message Catch
- Message Throw
- Event-Based Gateway (limited support)

### Flow

- Sequence Flow
- Exclusive Gateway (XOR split/join)
- Parallel Gateway (AND split/join)
- Inclusive Gateway (OR split/join, conservative join semantics)

### Activities

- Service Task (external callback work)
- User Task (external callback work)
- Embedded Subprocess (engine-managed scope)
- Call Activity (child instance or delegated execution)

## Architecture Overview

### Components

#### Model Service

- Deploy BPMN XML.
- Validate supported subset.
- Normalize into runtime graph representation.
- Precompute gateway metadata.

#### Runtime API

- Start instance.
- Submit work completion.
- Publish/deliver message.
- Submit decision result.
- Query instance state and history.

#### Engine Workers

- Claim continuations.
- Load instance state + model graph.
- Apply deterministic transition function.
- Append events.
- Update projection with optimistic version.
- Create new continuations and outbox messages.

#### Outbox Dispatcher

- Deliver callbacks.
- Retry with exponential backoff.
- Mark dead-letter after threshold.

### Core Patterns

- Event sourcing.
- Optimistic concurrency.
- Durable continuation queue.
- Outbox pattern.
- External decision evaluation.

## Core Execution Principles

### Determinism

The engine must not evaluate transition conditions internally.
All gateway decisions are made externally and recorded as events.

Replay must:

- Reconstruct state from events.
- Reuse recorded decisions.
- Never re-trigger external decision callbacks.

### Reliability

- State transitions are atomic and version-checked.
- Continuations are retried on failure.
- Callback delivery is at-least-once.
- All mutating API calls require commandId for idempotency.

### State Ownership

Engine owns:

- Tokens
- Scopes
- Wait states
- Timers
- Pending decisions
- Instance lifecycle

External systems own:

- Business variables
- AI reasoning
- Correlation logic (if desired)

## Data Model Overview

Collections:

- process_definitions
- process_instances
- process_instance_state
- process_instance_events
- continuations
- outbox

Recommendation:
Shard by instanceId where applicable.

### process_definitions

Stores deployed BPMN models in normalized runtime form.

Fields:

- _id: definitionId
- tenantId: optional
- name: string
- version: number
- bpmnXml: optional original XML
- graph: normalized runtime graph
- createdAt: timestamp

### process_instances

Stores instance metadata only.

Fields:

- _id: instanceId
- definitionId
- tenantId
- rootInstanceId
- parentInstanceId (optional)
- parentCallActivityId (optional)
- businessKey (optional)
- status: RUNNING | COMPLETED | TERMINATED | FAILED
- createdAt
- endedAt (optional)

### process_instance_state

Stores the current execution projection of a process instance.
This document is versioned and updated using optimistic concurrency.

Fields:

- _id: instanceId
- version: integer (monotonically increasing)

- status:
  RUNNING | COMPLETED | TERMINATED | FAILED

- tokens: array of execution tokens

  Each token contains:
  - tokenId
  - nodeId
  - scopeId
  - status: ACTIVE | WAITING | CONSUMED
  - createdAt
  - activation (optional, for OR-join tracking)
      - orSplitId

- scopes: array of execution scopes

  Each scope contains:
  - scopeId
  - kind: ROOT | SUBPROCESS
  - nodeId (subprocess node id for SUBPROCESS)
  - parentScopeId (optional)

- waits:

  workItems:
    - workItemId
    - nodeId
    - tokenId
    - scopeId
    - kind: SERVICE_TASK | USER_TASK
    - status: OPEN | COMPLETED | FAILED | CANCELED
    - createdAt
    - correlationHints (optional)

  messageSubs:
    - subscriptionId
    - messageName
    - nodeId
    - tokenId
    - scopeId
    - correlationKeys (optional)
    - createdAt

  timers:
    - timerId
    - nodeId
    - tokenId
    - scopeId
    - dueAt
    - isBoundary (boolean)
    - boundary (optional)
        - attachedToNodeId
        - interrupting (boolean)
    - createdAt

  decisions:
    - decisionId
    - kind: XOR_SPLIT | OR_SPLIT | EVENT_BASED_ARM | CORRELATION_KEYS
    - nodeId
    - tokenId
    - scopeId
    - optionsHash
    - contextRef (optional)
    - createdAt

- dedupe:

  processedCommandIds (bounded list)
  completedWorkItemIds (bounded list)
  processedMessageIds (bounded list)
  recordedDecisionIds (bounded list)

- lastEventSeq
- updatedAt

### process_instance_events

Append-only event store per instance.

Unique index:
(instanceId, seq)

Fields:

- _id
- instanceId
- seq (monotonic per instance)
- type
- at (timestamp)
- payload (JSON)

Minimum event types:

- INSTANCE_CREATED
- TOKEN_CREATED
- TOKEN_CONSUMED
- NODE_ENTERED
- NODE_LEFT
- WORK_ITEM_CREATED
- WORK_ITEM_COMPLETED
- WORK_ITEM_FAILED
- WORK_ITEM_CANCELED
- MESSAGE_SUBSCRIBED
- MESSAGE_RECEIVED
- TIMER_SCHEDULED
- TIMER_FIRED
- BOUNDARY_TRIGGERED
- SCOPE_CREATED
- SCOPE_ENDED
- DECISION_REQUESTED
- DECISION_RECORDED
- INSTANCE_COMPLETED
- INSTANCE_FAILED
- INSTANCE_TERMINATED

### continuations

Represents runnable units of execution.

Index:
(status, dueAt)

Fields:

- _id (continuationId)
- instanceId
- dueAt

- kind:
    START
    TOKEN_AT_NODE
    TIMER_DUE
    MESSAGE
    WORK_COMPLETED
    DECISION_RECORDED

- payload (JSON)

- status:
    READY
    IN_PROGRESS
    DONE
    DEAD

- ownerId (optional)
- leaseUntil (optional)
- attempts (integer)

- dedupeKey (optional)

- createdAt
- updatedAt

### outbox

Used to reliably deliver external callbacks.

Index:
(status, nextAttemptAt)

Fields:

- _id (outboxId)
- instanceId
- rootInstanceId

- kind:
    CALLBACK_WORK
    CALLBACK_DECISION
    CALLBACK_EVENT

- destination:
    - url
    - headers (optional)

- payload (JSON)

- status:
    READY
    SENT
    RETRY
    DEAD

- attempts
- nextAttemptAt
- lastError (optional)

- idempotencyKey

- createdAt
- updatedAt

## Normalized Graph Structure

All BPMN models are parsed and normalized into a runtime graph format.

The engine never executes BPMN XML directly.

### NormalizedGraph

Fields:

- processId
- nodes: map of nodeId -> NodeDef
- flows: map of flowId -> FlowDef
- startNodeIds: array of nodeIds

- metadata (precomputed for runtime efficiency):

    incomingByNode: map of nodeId -> flowIds[]
    outgoingByNode: map of nodeId -> flowIds[]

    upstreamSetByOrJoinIncoming:
        map of joinNodeId ->
            map of incomingFlowId -> nodeIds[]

## Execution Semantics

Execution is driven by continuations.

For each claimed continuation:

(state, continuation, graph, now)
    ->
{ events[], statePatch, newContinuations[], outbox[] }

All changes are committed atomically with optimistic version check.

### Start Event

On START continuation:

- Create root scope.
- Create token at each startNodeId.
- Emit TOKEN_CREATED events.
- Enqueue TOKEN_AT_NODE continuations.

### End Event

When a token reaches an end event:

- Consume token.
- Emit NODE_ENTERED, TOKEN_CONSUMED.
- If no ACTIVE or WAITING tokens remain:
    - Emit INSTANCE_COMPLETED.
    - Mark instance status COMPLETED.

### Sequence Flow

Flow traversal is implicit after node logic.

Outgoing flows are determined by node semantics:

- XOR → external decision
- OR → external decision
- AND → all outgoing
- normal node → all outgoing (usually one)

### Exclusive Gateway (XOR)

#### Split

When token reaches XOR gateway:

1. Create PendingDecision with:
   kind = XOR_SPLIT
   outgoing flows with conditions
   optionsHash

2. Emit DECISION_REQUESTED event.

3. Create outbox message:
   kind = CALLBACK_DECISION

4. Move token to WAITING state.

Engine pauses until decision is recorded.

#### Join

XOR join behaves as pass-through.

When a token arrives:

- Consume incoming token.
- Create one outgoing token.

### Parallel Gateway (AND)

#### Split

- Consume incoming token.
- Create one token per outgoing flow.

#### Join

- Wait until tokens from ALL incoming flows are present in the same scope.
- When all present:
    - Consume all.
    - Create one outgoing token.

### Inclusive Gateway (OR)

#### Split

1. Create PendingDecision:
   kind = OR_SPLIT
   outgoing flows + conditions.

2. Emit DECISION_REQUESTED.

3. Wait for DECISION_RECORDED.

4. When recorded:
   - For each selectedFlowId:
        create token.
   - Stamp activation.orSplitId on each created token.

#### Join (Conservative Semantics)

The join fires when:

1. At least one token for a given activationId has arrived.
2. No upstream token with same activationId exists that could still reach
   any not-yet-arrived incoming branch.

When firing:

- Consume all arrived tokens for activationId.
- Create single outgoing token.

### Service Task / User Task

When token enters task:

1. Create workItemId.
2. Move token to WAITING.
3. Add workItem to waits.workItems.
4. Emit WORK_ITEM_CREATED.
5. Create outbox message:
     kind = CALLBACK_WORK.

Engine waits for completion via API.

On completion:

1. Validate idempotency.
2. Emit WORK_ITEM_COMPLETED.
3. Remove wait state.
4. Resume token (create TOKEN_AT_NODE continuation).

### Timer Events

When timer is scheduled:

1. Create TimerRef in state.
2. Emit TIMER_SCHEDULED.
3. Create continuation:
     kind = TIMER_DUE
     dueAt = computed timestamp.

When TIMER_DUE is processed:

1. Validate timer still active.
2. Emit TIMER_FIRED.
3. Remove timerRef.
4. Apply boundary/intermediate semantics.

### Message Events

#### Message Catch

When token reaches catch event:

1. Create MessageSubscription.
2. Emit MESSAGE_SUBSCRIBED.
3. Move token to WAITING.

On message delivery:

1. Validate idempotency.
2. Emit MESSAGE_RECEIVED.
3. Resume token.

#### Message Throw

1. Emit CALLBACK_EVENT via outbox.
2. Continue token immediately.

## Decision Callback Contract

The engine does not evaluate transition conditions internally.
All condition evaluation is delegated to an external decision service.

### Decision Lifecycle

1. Token reaches decision point (e.g. XOR split).
2. Engine creates PendingDecision in state.
3. Engine emits DECISION_REQUESTED event.
4. Engine creates outbox message (CALLBACK_DECISION).
5. External service evaluates conditions.
6. External service submits decision via API.
7. Engine records DECISION_RECORDED event.
8. Engine resumes execution.

### Outbox Payload — CALLBACK_DECISION

Fields:

- type: DECISION_REQUIRED
- decisionId
- idempotencyKey
- tenantId (optional)
- rootInstanceId
- instanceId
- definitionId
- nodeId
- tokenId
- scopeId
- expectedStateVersion

- evaluation:
    kind: XOR_SPLIT | OR_SPLIT | EVENT_BASED_ARM | CORRELATION_KEYS
    outgoing:
        - flowId
        - toNodeId
        - condition
        - isDefault
    contextRef (optional)

The engine guarantees idempotency of decision requests via idempotencyKey.

### Decision Submission

Endpoint:
POST /v1/instances/{instanceId}/decisions/{decisionId}

Request fields:

- commandId (required)
- idempotencyKey (must match request)
- outcome:
    selectedFlowIds: array of flowIds
- explanation (optional)

Validation rules:

For XOR_SPLIT:
- Exactly one selectedFlowId must be provided.

For OR_SPLIT:
- Zero or more selectedFlowIds allowed.
- If none selected and no default flow exists,
  engine may mark instance FAILED.

On success:

1. Append DECISION_RECORDED event.
2. Remove PendingDecision from state.
3. Enqueue DECISION_RECORDED continuation.
4. Return ACCEPTED.

## Runtime API

All mutating endpoints require:

- commandId (UUID)
- Idempotent behavior based on commandId

### Deploy Definition

POST /v1/definitions

Request:
- name
- version
- bpmnXml
- tenantId (optional)

Response:
- definitionId

### Start Instance

POST /v1/instances

Request:
- commandId
- definitionId
- businessKey (optional)

Response:
- instanceId
- status

Engine:
- Emits INSTANCE_CREATED
- Enqueues START continuation

### Complete Work Item

POST /v1/instances/{instanceId}/work-items/{workItemId}/complete

Request:
- commandId
- result (optional)
- error (optional)

Behavior:

- Deduplicate via commandId and workItemId.
- Emit WORK_ITEM_COMPLETED or WORK_ITEM_FAILED.
- Resume token.

### Publish Message

POST /v1/messages/publish

Request:
- commandId
- messageId
- messageName
- correlationKeys
- payload

Engine:
- Match subscriptions.
- Emit MESSAGE_RECEIVED per match.
- Resume tokens.

### Query State

GET /v1/instances/{instanceId}

Returns:
- metadata
- status
- timestamps

GET /v1/instances/{instanceId}/state

Returns:
- projection state (tokens, waits, scopes)

GET /v1/instances/{instanceId}/events

Returns:
- event stream (paged)

## Worker Algorithm

### Claim Continuation

Atomic update:

Find:
- status = READY
- dueAt <= now

Update:
- status = IN_PROGRESS
- ownerId
- leaseUntil
- attempts++

### Process Continuation

1. Load instance state.
2. Load definition graph.
3. Apply transition function.
4. Attempt atomic commit:
    - append events
    - update state where version = expectedVersion
    - insert new continuations
    - insert outbox messages

If version mismatch:
- release continuation with short delay (retry).

### Lease Expiry Recovery

Background job:

- Find IN_PROGRESS with leaseUntil < now.
- Set status = READY.
- Increment attempts.

## OR-Join Algorithm

Each OR split assigns activationId.

Each created token receives:
- activation.orSplitId

At OR join:

For a given activationId:

1. Collect arrived tokens for join.
2. Identify incoming branches not yet satisfied.
3. For each unsatisfied branch:
   Check if any ACTIVE token with same activationId
   exists upstream of that branch.
4. If no upstream tokens can still reach missing branches:
   Fire join:
     - Consume arrived tokens.
     - Create single outgoing token.

This guarantees no premature join firing.

## Concurrency & Scaling

### Instance-Level Consistency

- All state updates use optimistic version check.
- Single logical writer per instance.
- Conflicts resolved by retry.

### Horizontal Scaling

- Multiple stateless workers.
- Shared MongoDB.
- Continuation queue enables work distribution.

### Hot Instance Protection

Recommended:

- Limit concurrent continuations per instance.
- Apply jitter on retry after version conflict.
- Monitor conflict rate metrics.

### Outbox Scaling

- Separate dispatcher pool.
- Exponential backoff with jitter.
- Dead-letter after configurable attempts.

## State Transition Matrix

This section defines the state transition matrix for the engine.

It specifies, per continuation kind and node type, what the engine must do to:

- consume tokens
- create tokens
- create waits
- emit events
- enqueue continuations
- enqueue outbox callbacks

Notation:

- T(token) = current token referenced by continuation
- consume(T) = mark token CONSUMED
- wait(T) = mark token WAITING
- createToken(nodeId, scopeId, activation?) = new ACTIVE token
- enqueue(kind, payload, dueAt) = new READY continuation
- outbox(kind, payload) = enqueue outbox message READY

All transitions must be committed atomically with:

- append events with increasing seq
- update process_instance_state where version == expectedVersion

### Continuation: START

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| START | instance.status = RUNNING; no tokens yet | create ROOT scope; for each startNodeId createToken(startNodeId, rootScope) | INSTANCE_CREATED (if not already emitted), SCOPE_CREATED, TOKEN_CREATED (per token) | TOKEN_AT_NODE (per start token) | none |

### Continuation: TOKEN_AT_NODE — Generic Template

For any node execution:

1. Emit NODE_ENTERED(nodeId, tokenId)
2. Apply node semantics
3. Emit NODE_LEFT(nodeId, tokenId) if node completes synchronously

If node creates a wait state, NODE_LEFT may be emitted either on wait creation or on resume.  
Implementation must be consistent across all node types.

### Node Type: startEvent

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at startEvent | token ACTIVE at startEvent | consume(T); for each outgoing flow createToken(toNode) | NODE_ENTERED, TOKEN_CONSUMED, TOKEN_CREATED (per outgoing) | TOKEN_AT_NODE (per outgoing token) | none |

### Node Type: endEvent

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at endEvent | token ACTIVE at endEvent | consume(T); if no ACTIVE or WAITING tokens remain → complete instance | NODE_ENTERED, TOKEN_CONSUMED, INSTANCE_COMPLETED (if completes) | none | optional CALLBACK_EVENT |

### Node Type: serviceTask / userTask

#### Create Work Item

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at task | token ACTIVE and no existing workItem | wait(T); create WorkItemRef | NODE_ENTERED, WORK_ITEM_CREATED | none | CALLBACK_WORK |

#### Complete Work Item

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| WORK_COMPLETED | workItem OPEN | mark COMPLETED; remove wait; createToken(toNode) | WORK_ITEM_COMPLETED, TOKEN_CREATED | TOKEN_AT_NODE | none |

#### Fail Work Item

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| WORK_COMPLETED with error | workItem OPEN | apply boundary error if exists; else mark instance FAILED | WORK_ITEM_FAILED, BOUNDARY_TRIGGERED (if applicable) | TOKEN_AT_NODE (boundary) | none |

### Node Type: exclusiveGateway (XOR Split)

#### Request Decision

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at XOR | token ACTIVE; no pending decision for token+node | wait(T); create PendingDecision(kind = XOR_SPLIT); store optionsHash | NODE_ENTERED, DECISION_REQUESTED | none | CALLBACK_DECISION |

#### Apply Decision

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| DECISION_RECORDED | pending decision exists | remove PendingDecision; consume(T); createToken(toNode) for selectedFlowId | DECISION_RECORDED, TOKEN_CONSUMED, TOKEN_CREATED | TOKEN_AT_NODE | none |

Validation:

- Exactly one selectedFlowId must be provided.
- If selectedFlowIds empty and default flow exists → use default.
- If no flow selected and no default → mark instance FAILED.

### Node Type: exclusiveGateway (XOR Join)

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at XOR join | token ACTIVE | consume(T); createToken(outgoing.toNode) | NODE_ENTERED, TOKEN_CONSUMED, TOKEN_CREATED | TOKEN_AT_NODE | none |

### Node Type: parallelGateway (AND Split)

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at AND split | token ACTIVE | consume(T); createToken(toNode) for each outgoing | NODE_ENTERED, TOKEN_CONSUMED, TOKEN_CREATED (per outgoing) | TOKEN_AT_NODE (per outgoing) | none |

### Node Type: parallelGateway (AND Join)

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at AND join | token ACTIVE | mark token arrived; if all incoming satisfied in same scope → consume all and createToken(outgoing.toNode) | NODE_ENTERED (per arrival), TOKEN_CONSUMED (all when firing), TOKEN_CREATED | TOKEN_AT_NODE | none |

Implementation notes:

- Required incoming flows from graph metadata.
- Scope must match.

### Node Type: inclusiveGateway (OR Split)

#### Request Decision

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at OR | token ACTIVE; no pending decision | wait(T); create PendingDecision(kind = OR_SPLIT) | NODE_ENTERED, DECISION_REQUESTED | none | CALLBACK_DECISION |

#### Apply Decision

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| DECISION_RECORDED | pending OR decision exists | remove PendingDecision; consume(T); assign activationId; createToken(toNode, activationId) for each selectedFlowId | DECISION_RECORDED, TOKEN_CONSUMED, TOKEN_CREATED (per selected) | TOKEN_AT_NODE (per created) | none |

Validation:

- Zero or more flows allowed.
- If none selected and default exists → use default.
- If none selected and no default → policy dependent (allow empty path or FAIL).

### Node Type: inclusiveGateway (OR Join)

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at OR join | token ACTIVE with activationId | mark arrival; if conservative condition satisfied → consume all arrived tokens for activationId and createToken(outgoing.toNode) | NODE_ENTERED, TOKEN_CONSUMED (all when firing), TOKEN_CREATED | TOKEN_AT_NODE | none |

Conservative condition:

- At least one token for activationId arrived.
- No upstream ACTIVE tokens with same activationId can reach any missing incoming branches.

### Node Type: intermediateCatchEvent (Timer)

#### Schedule Timer

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at timer catch | token ACTIVE | wait(T); create TimerRef(timerId, dueAt) | NODE_ENTERED, TIMER_SCHEDULED | TIMER_DUE(dueAt) | none |

#### Fire Timer

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TIMER_DUE | timerRef exists | remove timerRef; consume(waiting token); createToken(outgoing.toNode) | TIMER_FIRED, TOKEN_CONSUMED, TOKEN_CREATED | TOKEN_AT_NODE | none |

### Node Type: boundaryEvent (Timer)

Timer is scheduled when entering attached activity.

#### Fire Boundary Timer

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TIMER_DUE (boundary) | timerRef exists and attached activity still active | if interrupting → cancel activity token/workItem; if non-interrupting → keep original; createToken(boundary.outgoing) | TIMER_FIRED, BOUNDARY_TRIGGERED, WORK_ITEM_CANCELED (if interrupting), TOKEN_CREATED | TOKEN_AT_NODE | none |

Cancellation rules:

- Interrupting → original token consumed or canceled.
- Non-interrupting → original continues.

### Node Type: boundaryEvent (Error)

Error originates from WORK_COMPLETED with error.

| Source | Preconditions | Actions | Events | New Continuations | Outbox |
|--------|--------------|---------|--------|-------------------|--------|
| WORK_COMPLETED with error | matching boundary error exists | if interrupting → cancel activity; create boundary token; else → create boundary token only | WORK_ITEM_FAILED, BOUNDARY_TRIGGERED, TOKEN_CREATED | TOKEN_AT_NODE | none |

If no boundary matches:

- Mark instance FAILED.

### Node Type: messageCatchEvent

#### Subscribe

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at message catch | token ACTIVE | wait(T); create MessageSubscription | NODE_ENTERED, MESSAGE_SUBSCRIBED | none | none |

#### Deliver Message

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| MESSAGE | subscription exists | remove subscription; consume(waiting token); createToken(outgoing.toNode) | MESSAGE_RECEIVED, TOKEN_CONSUMED, TOKEN_CREATED | TOKEN_AT_NODE | none |

### Node Type: messageThrowEvent

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at message throw | token ACTIVE | consume(T); createToken(outgoing.toNode) | NODE_ENTERED, TOKEN_CONSUMED, TOKEN_CREATED | TOKEN_AT_NODE | CALLBACK_EVENT |

### Node Type: subProcess (embedded)

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at subProcess | token ACTIVE | create subprocess scope; consume(T); createToken(embeddedStart) | SCOPE_CREATED, TOKEN_CONSUMED, TOKEN_CREATED | TOKEN_AT_NODE | none |

Subprocess completion:

- When last token in subprocess scope ends:
  - Emit SCOPE_ENDED
  - CreateToken(outgoing.toNode)
  - Enqueue TOKEN_AT_NODE

### Node Type: callActivity

Strategy A (child instance) or Strategy B (external work).

Strategy B (recommended v1):

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| TOKEN_AT_NODE at callActivity | token ACTIVE | wait(T); create workItemRef(subtype = CALL_ACTIVITY) | WORK_ITEM_CREATED | none | CALLBACK_WORK |

### Continuation: DECISION_RECORDED

| Continuation | Preconditions | Actions | Events | New Continuations | Outbox |
|--------------|--------------|---------|--------|-------------------|--------|
| DECISION_RECORDED | decision exists and token WAITING | apply decision logic (XOR/OR); create outgoing token(s) | TOKEN_CREATED | TOKEN_AT_NODE | none |

Note:

- DECISION_RECORDED event appended when API accepts decision.
- This continuation resumes execution.

## Failure & Retry Matrix

### Definitions

- Continuation lease: time-bound claim.
- Commit: atomic append events + update state + insert continuations + insert outbox.
- Idempotency:
  - API → commandId
  - callbacks → idempotencyKey
  - decisions → decisionId
  - work completion → workItemId

### Continuation Failures

#### Worker crashes before claiming continuation

- Continuation remains READY.
- Another worker claims it.

#### Worker crashes after claiming, before commit

- Lease expires.
- Continuation reset to READY.

#### Worker crashes after commit but before marking DONE

- Retry occurs.
- Transition must be idempotent.
- Detect effect already applied.

### Optimistic Concurrency Conflicts

- Losing worker retries with jitter.
- Conflict retries should not dead-letter quickly.

Recommended:

- Retry delay 25–250ms with jitter.

### Outbox Failures

#### Dispatcher crashes before sending

- Outbox remains READY.

#### Dispatcher sends but crashes before marking SENT

- Duplicate delivery possible.
- Receiver must dedupe via idempotencyKey.

#### Transient error

- RETRY with exponential backoff.

#### Permanent error

- Mark DEAD after threshold.
- Optionally mark instance FAILED per policy.

### Work Item Failures

- Duplicate completion → idempotent success.
- Completion after cancel → 409 Conflict.
- Completion after instance end → 409 Conflict.

### Decision Failures

- Duplicate submission → idempotent.
- Stale decision → 409 Conflict.
- Decision service timeout → instance paused; optional FAIL after threshold.

### Timer Failures

- Duplicate TIMER_DUE → no-op if timerRef missing.
- Clock skew → process if dueAt <= now.

### Message Failures

- Duplicate messageId → dedupe.
- Delivery after subscription removed → no-op.
- Multiple subscriptions → broadcast (recommended).

### Instance Termination

- Termination clears waits/timers.
- Later continuations must no-op.

## Test Scenario Matrix

Minimum CI conformance suite.

Includes:

- Simple linear flow
- XOR routing
- AND split/join
- OR split/join
- Boundary timer (interrupting and non-interrupting)
- Duplicate completion
- Duplicate decision
- Worker crash recovery
- Outbox duplicate delivery
- Message catch
- Instance termination

Engine is conformant when:

- All scenarios pass.
- Event order strictly monotonic.
- No duplicate tokens.
- No duplicate joins.
- Idempotency protections hold.
- Replay reconstructs identical projection state.

# Additional, important Aspects

* All database tables should be named camel-case, upper-case first letter, no '_'
* Database URL is in .env in `MONGO_URL`