# Usage Guide

Develop against the tri-bpmn-engine using the **SDK**. The SDK supports two modes:

- **REST mode** – connect to a running engine server over HTTP
- **Local mode** – use the engine directly, no server (ideal for tests and in-process use)

Same API in both modes; switch with config.

---

## Install

```bash
npm install
# or add tri-bpmn-engine as a dependency in your project
```

---

## Quick Start

### REST mode (server running)

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { v4 as uuidv4 } from 'uuid';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});

const { definitionId } = await client.deploy({
  name: 'OrderProcess',
  version: 1,
  bpmnXml: '<bpmn:definitions>...</bpmn:definitions>',
});

const { instanceId } = await client.startInstance({
  commandId: uuidv4(),
  definitionId,
});

const state = await client.getState(instanceId);
const workItem = state?.waits.workItems[0];
if (workItem) {
  await (workItem.kind === 'USER_TASK'
    ? client.completeUserTask(instanceId, workItem.workItemId)
    : client.completeExternalTask(instanceId, workItem.workItemId));
}

const instance = await client.getInstance(instanceId);
console.log('Status:', instance?.status);
```

Start the server first: `npm run dev` (default port 3000).

---

### Local mode (no server)

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { connectDb, ensureIndexes, closeDb } from 'tri-bpmn-engine/db';
import { v4 as uuidv4 } from 'uuid';

require('dotenv').config();

const db = await connectDb();
await ensureIndexes(db);

const client = new BpmnEngineClient({ mode: 'local', db });

const { definitionId } = await client.deploy({
  name: 'OrderProcess',
  version: 1,
  bpmnXml: '<bpmn:definitions>...</bpmn:definitions>',
});

const { instanceId } = await client.startInstance({
  commandId: uuidv4(),
  definitionId,
});

// Option A: inline handlers
const result = await client.processUntilComplete(instanceId, {
  onWorkItem: async (item) => {
    if (item.payload.kind === 'userTask') {
      await client.completeUserTask(item.instanceId, item.payload.workItemId);
    } else {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    }
  },
});

// Option B: init once, then process without passing handlers
// client.init({ onWorkItem: ..., onDecision: ... });
// const result = await client.processUntilComplete(instanceId);

console.log('Status:', result.status);

await closeDb();
```

---

## Core APIs (Server Programming Model)

A server that embeds the engine and hosts callbacks typically uses **init** once at startup, then the 5 operational APIs:

### init (once at server start)

Register how to process interruptions and your service vocabulary. Call once before using the engine.

```typescript
client.init({
  onWorkItem: async (item) => {
    await presentToUser(item);
    await client.completeUserTask(item.instanceId, item.payload.workItemId, { result });
  },
  onServiceCall: async (item) => {
    const toolId = item.payload.extensions?.['tri:toolId'];
    const impl = toolId ? (client.getServiceVocabulary() as Record<string, (i: unknown) => Promise<void>>)?.[toolId] : undefined;
    await impl?.(item);
    await client.completeExternalTask(item.instanceId, item.payload.workItemId);
  },
  onDecision: async (item) => {
    const choice = await evaluate(item.payload);
    await client.submitDecision(item.instanceId, item.payload.decisionId, { selectedFlowIds: [choice] });
  },
  serviceVocabulary: { 'approval-mail-tool': sendApprovalMail, '69627240...': promptTool },
});
```

### 5 operational APIs

| API | When to use |
|-----|-------------|
| **deploy** | Register a process model (BPMN). Find it later by name, id, version. |
| **startInstance** | Start a new process from a deployed definition. |
| **completeUserTask** | A human completed a user task. Advances the process. |
| **completeExternalTask** | An external system completed (e.g. async message, long-running call). Advances the process. |
| **recover** | Process all pending continuations after server restart. Uses init handlers. Drains the queue. |

`completeUserTask` and `completeExternalTask` are semantic aliases for the same underlying operation. For gateway decisions, your `onDecision` handler calls `submitDecision()`. `recover()` uses the handlers from `init()`; you can override with `recover({ handlers: {...} })`. Local mode only.

---

## SDK API Reference

### Constructor

```typescript
new BpmnEngineClient(config: SdkConfig)
```

**REST config:**

```typescript
{ mode: 'rest'; baseUrl: string }
```

**Local config:**

```typescript
{ mode: 'local'; db: Db }
```

`Db` is MongoDB’s `Db` from `mongodb`. Use `connectDb()` from `tri-bpmn-engine/db` or your own `MongoClient.db()`.

---

### init(config)

Initialize the engine (call once at server start). Registers how to process interruptions and optional service vocabulary.

```typescript
client.init({
  onWorkItem: async (item) => { /* user tasks: completeUserTask */ },
  onServiceCall: async (item) => { /* service tasks: invoke, then completeExternalTask */ },
  onDecision: async (item) => { /* evaluate, then submitDecision */ },
  serviceVocabulary: { 'tool-id': async (item) => { /* invoke */ } },
});
```

`recover()` and `processUntilComplete()` use these handlers when no override is passed. Use `client.getServiceVocabulary()` inside handlers to resolve tools.

---

### getServiceVocabulary()

Return the service vocabulary from `init()`. Use inside `onServiceCall` to resolve `tri:toolId` (from `item.payload.extensions?.['tri:toolId']`) to an implementation.

```typescript
const vocab = client.getServiceVocabulary();
const impl = vocab?.[item.payload.extensions?.['tri:toolId'] ?? ''];
```

---

### deploy(params)

Deploy a BPMN process definition.

```typescript
const { definitionId } = await client.deploy({
  name: 'MyProcess',
  version: 1,
  bpmnXml: '<?xml version="1.0"?><bpmn:definitions>...</bpmn:definitions>',
  tenantId: 'optional',
});
```

---

### startInstance(params)

Start a new instance.

```typescript
const { instanceId, status } = await client.startInstance({
  commandId: uuidv4(),
  definitionId,
  businessKey: 'order-123',
  tenantId: 'optional',
});
```

---

### getInstance(instanceId)

Get instance summary (id, status, timestamps). Returns `null` if not found.

```typescript
const instance = await client.getInstance(instanceId);
// { _id, status, createdAt, endedAt? }
```

---

### getState(instanceId)

Get full execution state: tokens, work items, pending decisions. Returns `null` if not found.

```typescript
const state = await client.getState(instanceId);
// state.waits.workItems  - open user/service tasks
// state.waits.decisions   - pending gateway decisions
// state.tokens, state.scopes, state.status, state.version
```

---

### completeUserTask(instanceId, workItemId, options?)

Human completed a user task. Advances the process.

```typescript
await client.completeUserTask(instanceId, workItemId, {
  commandId: uuidv4(),
  result: { approved: true },
});
```

---

### completeExternalTask(instanceId, workItemId, options?)

External system completed (e.g. async message, long-running call). Advances the process.

```typescript
await client.completeExternalTask(instanceId, workItemId, {
  result: { response: data },
});
```

---

### completeWorkItem(instanceId, workItemId, options?)

Complete a user or service task. Prefer `completeUserTask` or `completeExternalTask` for clarity.

```typescript
await client.completeWorkItem(instanceId, workItemId, {
  commandId: uuidv4(),
  result: { approved: true },
});
```

In REST mode, the server worker will pick it up. In local mode, `processUntilComplete` or `recover` continues automatically.

---

### recover(options?)

Process all pending continuations (e.g. after server restart). Uses handlers from `init()` unless overridden. Local mode only.

```typescript
// Uses init handlers
const { processed } = await client.recover();

// Override handlers for this call
const { processed } = await client.recover({
  handlers: { onWorkItem: ..., onDecision: ... },
  maxIterations: 5000,
});
```

---

## Callbacks for User Tasks and Service Tasks

User tasks and service tasks create **work items** that your application must handle. The engine does not execute them; your code acts as the callback handler.

### How It Works

1. Execution reaches a user or service task → the engine creates a work item and pauses.
2. Your application discovers the work item via `getState()` or callbacks.
3. You perform the work (human input or external service call).
4. You call `completeUserTask()` or `completeExternalTask()` to signal completion.
5. The engine resumes execution (via its worker) and moves the token onward.

### Work item payload

`CALLBACK_WORK` payload includes `workItemId`, `nodeId`, `kind` ('userTask' | 'serviceTask'), `name`, `lane`. If the BPMN node has custom extension attributes (e.g. `tri:toolId`, `tri:toolType`), they appear in `payload.extensions`:

```typescript
const toolId = item.payload.extensions?.['tri:toolId'];
const toolType = item.payload.extensions?.['tri:toolType'];
```

### User Tasks

User tasks represent **human work**. Your application:

1. Discovers the work item via `subscribeToCallbacks()` or `processUntilComplete()` handlers—same pattern as service tasks.
2. Presents the task to a user (UI, inbox, etc.).
3. Waits for the user to act (approve, reject, fill a form, etc.).
4. Calls `completeUserTask()` with optional `result` when done.

```typescript
await client.processUntilComplete(instanceId, {
  onWorkItem: async (item) => {
    if (item.payload.kind === 'userTask') {
      // Show task to user: "Approve order #123"
      const approved = await waitForUserDecision(); // your UI logic
      await client.completeUserTask(item.instanceId, item.payload.workItemId, {
        result: { approved },
      });
    } else {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    }
  },
});
```

### Service Tasks (Push-Based: No Polling)

Service tasks represent **automated work** (external API, internal service, async job). Use `subscribeToCallbacks()` to receive work items—the stream comes from the engine, not from MongoDB. **MongoDB is purely a passive persistence layer.**

#### How the engine notifies you

When execution reaches a service task, the engine:

1. Creates a work item in instance state
2. Persists to the Outbox (for audit/replay)
3. Streams the callback to your app (local: via subscribeToCallbacks internal loop; REST: via WebSocket)

Your app receives callbacks from the engine. MongoDB is not watched or polled for notifications.

#### Local mode: subscribeToCallbacks

`subscribeToCallbacks` starts an internal loop that runs the worker. When the engine produces callbacks (work items, decisions), your handler is invoked immediately.

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { connectDb, ensureIndexes, closeDb } from 'tri-bpmn-engine/db';

async function main() {
  const db = await connectDb();
  await ensureIndexes(db);
  const client = new BpmnEngineClient({ mode: 'local', db });

  const unsubscribe = client.subscribeToCallbacks((item) => {
    if (item.kind === 'CALLBACK_WORK') {
      const { workItemId, instanceId, nodeId, kind } = item.payload;
      if (kind === 'serviceTask') {
        (async () => {
          const response = await callYourService(instanceId, nodeId);
          await client.completeExternalTask(instanceId, workItemId, { result: response });
          // Subscription's internal loop picks up the continuation automatically
        })().catch(console.error);
      }
    }
  });

  // Run until process exit; call unsubscribe() when done
}

async function callYourService(instanceId: string, nodeId: string) {
  return { success: true };
}
```

**Event-driven (recommended): processUntilComplete**

Register callbacks up front. No polling—the engine invokes handlers when work items or decisions appear.

```typescript
const result = await client.processUntilComplete(instanceId, {
  onWorkItem: async (item) => {
    if (item.payload.kind === 'serviceTask') {
      const response = await callYourService(item.instanceId, item.payload.nodeId);
      await client.completeExternalTask(item.instanceId, item.payload.workItemId, { result: response });
    }
    // User tasks: forward to worklist; complete when human does the task
  },
  onDecision: async (item) => {
    const selectedFlowIds = evaluateTransitionCondition(item.payload);
    await client.submitDecision(item.instanceId, item.payload.decisionId, { selectedFlowIds });
  },
});
// result.status === 'COMPLETED' | 'TERMINATED' | 'FAILED'
```

#### REST mode: WebSocket

In REST mode, the server exposes a **WebSocket** at `/ws`. Use `subscribeToCallbacks()` to receive work items and decisions in real time—no polling.

The server broadcasts to all connected clients whenever a CALLBACK_WORK or CALLBACK_DECISION is written to the Outbox (when execution reaches a service/user task or decision gateway).

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { v4 as uuidv4 } from 'uuid';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});

const unsubscribe = client.subscribeToCallbacks((item) => {
  if (item.kind === 'CALLBACK_WORK') {
    const { workItemId, instanceId, nodeId, kind } = item.payload;

    if (kind === 'serviceTask') {
      (async () => {
        const response = await callYourService(instanceId, nodeId);
        await client.completeExternalTask(instanceId, workItemId, { result: response });
      })().catch(console.error);
    }
    // User tasks: forward to your task UI
  }
  // CALLBACK_DECISION: external decision service receives and submits via submitDecision()
});

// When done:
// unsubscribe();
```

**REST vs Local—event-driven, no polling**

| Mode   | Push mechanism                         |
|--------|----------------------------------------|
| REST   | WebSocket at `{baseUrl}/ws`            |
| Local  | `processUntilComplete()` or `subscribeToCallbacks()` |

### Remote architecture: WebSocket and webhooks

- **WebSocket** (current): Clients connect to `/ws`. The server broadcasts `CALLBACK_WORK` and `CALLBACK_DECISION` when execution reaches tasks or gateways. Clients react by calling `completeUserTask()` / `completeExternalTask()` / `submitDecision()` via REST. No polling.
- **Webhooks** (future): For server-to-server integration, the engine could POST callbacks to configured URLs. Same payload shape as WebSocket.

### Complete Callback Flow

```
startInstance → processUntilComplete (local) or server runs worker (REST)
     ↓
  Token reaches user/service task
     ↓
  Work item created; CALLBACK_WORK written to Outbox
     ↓
  Your app receives callback (push, no polling):
     - REST:  subscribeToCallbacks() → WebSocket at /ws
     - Local: subscribeToCallbacks() → internal engine loop
     ↓
  Do work (invoke service or present to user)
     ↓
  completeUserTask() / completeExternalTask() → engine loop picks up (local) or server picks up (REST)
     ↓
  Token moves to next node (or instance completes)
```

### Optional `result` Payload

You can pass arbitrary data via `result`. Downstream flow conditions or expressions (if supported) can use it.

```typescript
await client.completeUserTask(instanceId, workItemId, {
  result: {
    approved: true,
    comments: 'Looks good',
    metadata: { reviewedBy: 'alice' },
  },
});
```

### REST vs Local Mode

- **REST mode**: The server runs the worker loop. Use `subscribeToCallbacks()` (WebSocket) to receive callbacks; react by calling `completeUserTask()` / `completeExternalTask()` / `submitDecision()`. No polling.
- **Local mode**: Call `init()` once, then `processUntilComplete(instanceId)` or `recover()` to run—handlers from init are invoked. Or pass handlers inline. Use `subscribeToCallbacks()` for background processing.

---

### submitDecision(instanceId, decisionId, options)

Submit a decision for an XOR gateway.

```typescript
await client.submitDecision(instanceId, decisionId, {
  selectedFlowIds: ['Flow_A'],
  commandId: uuidv4(),
});
```

In REST mode, the server worker will pick it up. In local mode, `processUntilComplete` continues automatically.

#### Decision callback payload (LLM-friendly)

The `CALLBACK_DECISION` payload is structured for LLM integration. You get direct access to BPMN strings and model metadata:

| Field | Description |
|-------|-------------|
| `instanceId` | Process instance ID (data pool context) |
| `gateway` | `{ id, name, type }` — the decision point |
| `transitions` | Array of alternatives, each with: |
| `transitions[].flowId` | Flow identifier (pass to `selectedFlowIds`) |
| `transitions[].name` | Transition label from BPMN (e.g. "Claim approved?", "default") |
| `transitions[].conditionExpression` | Expression from BPMN (e.g. `${approved}`) |
| `transitions[].isDefault` | `true` when no condition matches |
| `transitions[].targetNodeName` | Target task name (e.g. "Send Approval Mail") |
| `transitions[].targetNodeType` | Target node type (e.g. "serviceTask") |

**Evaluating gateway name + transition conditions**

The gateway `name` is the decision question; each transition's `name` is the option label. Together they form a clear yes/no or multi-choice prompt.

Example from xor-with-transition-conditions BPMN:

- **Gateway**: `{ name: "Can be approved?" }`
- **Transitions**: `[ { flowId: "Flow_Rejection", name: "No", isDefault: true }, { flowId: "Flow_Approval", name: "Yes", conditionExpression: "${approved}" } ]`

To evaluate:

1. **Expression-based**: If you have process data (e.g. `approved: true`), evaluate `conditionExpression` against it. When `${approved}` is truthy, choose the "Yes" flow; otherwise use the default ("No").
2. **LLM-based**: Prompt with `gateway.name` (e.g. "Can be approved?") and the transition labels (`transitions[].name`: "No", "Yes") plus your context. The LLM returns the chosen option; map back to `flowId` and call `submitDecision(instanceId, decisionId, { selectedFlowIds: [flowId] })`.

---

### processUntilComplete(instanceId, handlers?, options?)

Process until instance reaches a terminal state. **Local mode only.** Uses handlers from `init()` when omitted. Invokes handlers for each callback—no polling.

```typescript
const result = await client.processUntilComplete(instanceId, {
  onWorkItem: async (item) => {
    if (item.payload.kind === 'userTask') {
      await client.completeUserTask(item.instanceId, item.payload.workItemId);
    } else {
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    }
  },
  onDecision: async (item) => {
    // Evaluate transition, submit choice
    await client.submitDecision(item.instanceId, item.payload.decisionId, {
      selectedFlowIds: [chosenFlowId],
    });
  },
}, { maxIterations: 500 });
// result.status === 'COMPLETED' | 'TERMINATED' | 'FAILED'
```

---

### subscribeToCallbacks(callback)

Subscribe to work items and decisions. Returns an unsubscribe function. **REST**: WebSocket at /ws. **Local**: internal engine loop (MongoDB passive).

```typescript
  const unsubscribe = client.subscribeToCallbacks((item) => {
    if (item.kind === 'CALLBACK_WORK') {
      const { workItemId, instanceId, kind } = item.payload;
      // Handle work item, then completeUserTask/completeExternalTask
    }
  });

unsubscribe(); // when done
```

Same API in both modes—stream always comes from the engine.

---

## Example: Linear Process (Local Mode)

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { connectDb, ensureIndexes, closeDb } from 'tri-bpmn-engine/db';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';

async function main() {
  require('dotenv').config();
  const db = await connectDb();
  await ensureIndexes(db);

  const client = new BpmnEngineClient({ mode: 'local', db });

  const bpmn = readFileSync('./test/bpmn/start-service-task-end.bpmn', 'utf8');
  const { definitionId } = await client.deploy({
    name: 'LinearDemo',
    version: 1,
    bpmnXml: bpmn,
  });

  const { instanceId } = await client.startInstance({
    commandId: uuidv4(),
    definitionId,
  });

  const result = await client.processUntilComplete(instanceId, {
    onWorkItem: async (item) => {
      if (item.payload.kind === 'userTask') {
        await client.completeUserTask(item.instanceId, item.payload.workItemId);
      } else {
        await client.completeExternalTask(item.instanceId, item.payload.workItemId);
      }
    },
  });
  console.log('Completed:', result.status === 'COMPLETED');

  await closeDb();
}

main().catch(console.error);
```

---

## Example: XOR Gateway (Local Mode)

```typescript
const client = new BpmnEngineClient({ mode: 'local', db });

const { definitionId } = await client.deploy({
  name: 'XorDemo',
  version: 1,
  bpmnXml: xorBpmnXml,
});

const { instanceId } = await client.startInstance({
  commandId: uuidv4(),
  definitionId,
});

const result = await client.processUntilComplete(instanceId, {
  onDecision: async (item) => {
    await client.submitDecision(item.instanceId, item.payload.decisionId, {
      selectedFlowIds: ['Flow_A'],
    });
  },
});
```

---

## When to Use Each Mode

| Use case | Mode |
|----------|------|
| Production: engine as separate service | REST |
| Tests, scripts, embedded engine | Local |
| No MongoDB in your process | REST (server has Mongo) |
| Full control, no network | Local |

---

## End-to-End Example: Case Processing

This walkthrough runs the **linear-service-and-user-task** process: a case flow with user tasks (FrontOffice → BackOffice → Accounting) and a service task in between. Callbacks include task **name** and **role** (lane) for routing.

### Process overview

```
Start → EnterCaseData (FrontOffice) → AssessCase (service) → ApproveAssessment (BackOffice) → InitiatePayment (Accounting) → End
```

BPMN file: `test/bpmn/linear-service-and-user-task.bpmn` (in the repo)

### Full script (local mode)

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { connectDb, ensureIndexes, closeDb } from 'tri-bpmn-engine/db';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';

require('dotenv').config();

async function main() {
  const db = await connectDb();
  await ensureIndexes(db);
  const client = new BpmnEngineClient({ mode: 'local', db });

  const bpmn = readFileSync('./test/bpmn/linear-service-and-user-task.bpmn', 'utf8');
  const { definitionId } = await client.deploy({
    name: 'CaseProcess',
    version: 1,
    bpmnXml: bpmn,
  });

  const { instanceId } = await client.startInstance({
    commandId: uuidv4(),
    definitionId,
  });

  console.log('Started instance:', instanceId);

  // Process until complete; handlers receive callbacks with name and role (lane)
  const result = await client.processUntilComplete(instanceId, {
    onWorkItem: async (item) => {
      const { name, lane, kind } = item.payload;
      console.log(`[Callback] ${kind} "${name}" (role: ${lane ?? '—'})`);

      if (kind === 'serviceTask') {
        console.log(`  → Invoking service "${name}"`);
        await client.completeExternalTask(instanceId, item.payload.workItemId, {
          result: { score: 0.85 },
        });
      } else {
        console.log(`  → User in ${lane ?? '—'} completes "${name}"`);
        await client.completeUserTask(instanceId, item.payload.workItemId, {
          result: { completed: true },
        });
      }
    },
  });
  console.log('Final status:', result.status);

  await closeDb();
}

main().catch(console.error);
```

### Example output

```
Started instance: abc123...
[Callback] userTask "EnterCaseData" (role: FrontOffice)
  → User in FrontOffice completes "EnterCaseData"
[Callback] serviceTask "AssessCase" (role: —)
  → Invoking service "AssessCase"
[Callback] userTask "ApproveAssessment" (role: BackOffice)
  → User in BackOffice completes "ApproveAssessment"
[Callback] userTask "InitiatePayment" (role: Accounting)
  → User in Accounting completes "InitiatePayment"
Final status: COMPLETED
```

### Using subscribeToCallbacks

Same process, push-based—your handler receives callbacks with `name` and `lane` for routing:

```typescript
const unsubscribe = client.subscribeToCallbacks((item) => {
  if (item.kind === 'CALLBACK_WORK') {
    const { workItemId, instanceId, name, lane, kind } = item.payload;
    console.log(`[Callback] ${kind} "${name}" (role: ${lane ?? '—'})`);

    if (kind === 'serviceTask') {
      // Invoke your service; when done: completeExternalTask (loop picks up automatically)
      invokeService(instanceId, workItemId).catch(console.error);
    } else {
      // Forward to task UI for users in lane (role); when done: completeUserTask
      addToTaskInbox(instanceId, workItemId, { name, role: lane });
    }
  }
});

// unsubscribe();  // when shutting down
```

### Callback payload

Each `CALLBACK_WORK` item includes:

| Field | Description |
|-------|-------------|
| `workItemId` | Pass to `completeUserTask()` or `completeExternalTask()` |
| `instanceId` | Process instance |
| `nodeId` | BPMN node id |
| `kind` | `'serviceTask'` or `'userTask'` |
| `name` | Task name from BPMN |
| `lane` | Lane name (role) from BPMN, if the task is in a lane |

---

## End-to-End Example: Worklist Flow

This example uses the **worklist** instead of inline callbacks. A human (or UI) polls the worklist, activates tasks, and completes them. The engine runs in the background; handlers process only decisions and service tasks. User tasks are handled via the worklist API.

### Sequence

1. **Process start** – Start instance with user (for `startedBy`).
2. **Run engine** – Process until first user task (handlers skip user tasks, handle decisions and service tasks).
3. **Wait** – A few seconds for the worklist projection to apply.
4. **Load worklist** – Query open tasks for the instance.
5. **Pick task** – Choose a task (e.g. oldest in process order).
6. **Activate** – Transition task OPEN → CLAIMED, blocking other users.
7. **Complete** – Submit completion to the engine.
8. **Run engine** – Process the completion, advance to the next user task or end.
9. **Repeat** – Loop until instance status is COMPLETED.

### Process overview

Uses **xor-with-transition-conditions**: Claim Entry (Beneficiary) → Claim Assessment (Claims Assessor) → XOR decision → Send Approval/Rejection Mail (service) → End.

BPMN file: `test/bpmn/xor-with-transition-conditions.bpmn`

### Worklist API

| Operation | SDK | REST |
|-----------|-----|------|
| List tasks | `client.listTasks({ instanceId, status: 'OPEN', sortOrder: 'asc' })` | `GET /v1/tasks?instanceId=…&status=OPEN` |
| Activate | `client.activateTask(taskId, { userId })` | `POST /v1/tasks/:taskId/activate` |
| Complete | `client.completeUserTask(instanceId, taskId, { user })` | `POST /v1/tasks/:taskId/complete` or engine work-items endpoint |

### Example script (local mode)

```typescript
import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
import { connectDb, ensureIndexes, closeDb } from 'tri-bpmn-engine/db';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';

require('dotenv').config();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = await connectDb();
  await ensureIndexes(db);
  const client = new BpmnEngineClient({ mode: 'local', db });

  // ─── 1. Initialize callbacks (once, before any deploy/start) ───
  client.init({
    onWorkItem: async (item) => {
      // Here, we need to decide whether we can push the user activity into the (linear) conversation or into a worklist

      return;
    },
    onServiceCall: async (item) => {
      // Obtain the agentic tool to invoke and resolve parameters

      const toolId = item.payload.extensions?.['tri:toolId'];
      const toolType = item.payload.extensions?.['tri:toolType'];

      console.log('Service call:', { toolId, toolType });

      // Once tool is completed retrieve data and output, add to conversation and continue process
      
      await client.completeExternalTask(item.instanceId, item.payload.workItemId);
    },
    onDecision: async (item) => {
      const { gateway, transitions } = item.payload;
      // gateway.name = "Can be approved?"; transitions = [{ flowId, name: "No", isDefault: true }, { flowId, name: "Yes", conditionExpression: "${approved}" }]

      // We will create a prompt with the question to evaluated and combine with entries from the data pool
      // Probably to retrieve an evaluation condition
      
      const approved = true; 
      const selected = approved
        ? transitions?.find((t) => t.conditionExpression)?.flowId
        : transitions?.find((t) => t.isDefault)?.flowId;
      if (selected) {
        await client.submitDecision(item.instanceId, item.payload.decisionId, {
          selectedFlowIds: [selected],
        });
      }
    },
  });

  // ─── 2. Deploy process definition ───
  const bpmn = readFileSync('./test/bpmn/xor-with-transition-conditions.bpmn', 'utf8');
  const { definitionId } = await client.deploy({
    name: 'ClaimProcess',
    version: 1,
    bpmnXml: bpmn,
  });

  // ─── 3. Start process instance ───
  const user = { email: 'user@example.com' };
  const { instanceId } = await client.startInstance({
    commandId: uuidv4(),
    definitionId,
    user,
  });
  console.log('Started instance:', instanceId);

  // ─── 4. Run engine until quiescent (handlers process decisions and service tasks) ───
  let result = await client.run(instanceId);

  // ─── 5. Worklist loop: wait → load → activate → complete → run, repeat ───
  while (result.status === 'RUNNING') {
    await sleep(5000);

    const openTasks = await client.listTasks({
      instanceId,
      status: 'OPEN',
      sortOrder: 'asc',
    });

    if (openTasks.length === 0) {
      result = await client.run(instanceId);
      continue;
    }

    const task = openTasks[0];
    console.log('Activating and completing:', task.name);

    await client.activateTask(task._id, { userId: user.email });
    await client.completeUserTask(instanceId, task._id, { user });

    result = await client.run(instanceId);
  }

  console.log('Final status:', result.status);
  await closeDb();
}

main().catch(console.error);
```

### APIs used

| Step | API | Description |
|------|-----|-------------|
| 1 | `client.init({ onWorkItem, onServiceCall, onDecision })` | Register callbacks once before use |
| 2 | `client.deploy({ name, version, bpmnXml })` | Deploy process definition |
| 3 | `client.startInstance({ commandId, definitionId, user })` | Start new instance |
| 4–5 | `client.run(instanceId)` | Process continuations; handlers process decisions and service tasks |
| Loop | `client.listTasks({ instanceId, status: 'OPEN', sortOrder: 'asc' })` | Load worklist (OPEN tasks) |
| Loop | `client.activateTask(taskId, { userId })` | Activate task (OPEN → CLAIMED) |
| Loop | `client.completeUserTask(instanceId, taskId, { user })` | Complete task; engine processes on next `run()` |

### Test reference

See `test/sdk/xor-with-transition-conditions.test.ts` for the full test: `worklist flow: start → wait → load → activate → complete, repeat for each user task`. It uses `client.listTasks`, `client.activateTask`, and `client.completeUserTask`.

---

## Prerequisites

- Node.js 18+
- MongoDB (set `MONGO_URL` in `.env`)

For REST mode, start the engine server: `npm run dev`.
