<div align="center">

<img src="./docs/logo.png" alt="in-concert logo" width="200" />

# in concert

**BPMN 2.0 EXECUTION ENGINE**

*BY THE REAL INSIGHT GMBH*

---

**A production-grade BPMN 2.0 execution engine for Node.js**

*Event-sourced · Optimistic concurrency · Push-style callbacks · REST & embedded*

[![npm version](https://img.shields.io/npm/v/@the-real-insight/in-concert?style=flat-square&color=0f172a&labelColor=64748b)](https://www.npmjs.com/package/@the-real-insight/in-concert)
[![License](https://img.shields.io/badge/license-TRI--MIT-0f172a?style=flat-square&labelColor=64748b)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-0f172a?style=flat-square&labelColor=64748b)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-0f172a?style=flat-square&labelColor=64748b)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/github/actions/workflow/status/The-Real-Insight/in-concert/test.yml?style=flat-square&label=tests&labelColor=64748b)](https://github.com/The-Real-Insight/in-concert/actions/workflows/test.yml)

<br/>

[**Get started →**](#quick-start) · [**Documentation**](./docs/README.md) · [**npm**](https://www.npmjs.com/package/@the-real-insight/in-concert) · [**Contributing**](./docs/contributing.md)

</div>

---

## What's new

### Per-instance synopsis — tell parallel cases apart at a glance

**Worklists with twenty rows that all say "Customer Inquiry – 14:23" are unusable.** A new `instanceSynopsis` field on `ProcessInstance` carries a short human-readable label — "von Lisa Palfinger zu Glasscherben in Raum X" — so users can pick the right row without opening it. The platform owns the field, the SDK setter, and an audit-friendly source flag (`auto` vs `manual`). Generation policy stays in the host: prompt, model choice, language, length-in-words are all yours to tune per product.

```typescript
// In a post-task-completion hook on the host side:
const previous = await engine.getInstanceSynopsis(instanceId);
if (previous?.source === 'manual') return;   // user pinned it; don't overwrite

const activities = await engine.completedActivities(instanceId, { limit: 8 });
const synopsis = await myLlm.summarize({
  processName, processDescription,
  activities,
  dataPool: await myDataPool.snapshot(instanceId),
  previous: previous?.text,                   // anchor: refine, don't reinvent
  locale: 'de',
});

await engine.setInstanceSynopsis(instanceId, synopsis, { source: 'auto' });
```

Three new SDK methods carry the contract: `getInstanceSynopsis`, `setInstanceSynopsis`, and a generalized `completedActivities` helper that returns the ordered "what has happened on this case so far" view. The synopsis surface is the first consumer of `completedActivities`; audit views and the eventual "explain this case" feature are the obvious next ones.

The platform enforces only the bare backstop — non-empty text, hard 200-char ceiling, source flag preserved — and stays out of generation policy. Manual override is a single call (`setInstanceSynopsis(id, text, { source: 'manual' })`) that the auto path is contractually obliged to respect.

### Mailbox triggers — filter by subject before you spend an instance

**Same mailbox, different processes, picked apart by subject.** The `graph-mailbox` trigger now accepts an optional `tri:subjectPattern` regex on its `<bpmn:message>`. Mails whose subject doesn't match never become a process instance — no idempotency lookup, no attachment download, no host callback, no `terminate` cleanup. The non-matching mail is marked as read so it doesn't loop on the next poll, and the trigger report books it as `dropped('subject-mismatch')` so operators can tell "filter too tight" from "inbox quiet."

```xml
<!-- Start a process only for mails whose subject looks like a purchase order. -->
<bpmn:message id="Msg_OrderIntake"
  tri:connectorType="graph-mailbox"
  tri:mailbox="orders@acme.com"
  tri:subjectPattern="^Bestellung:\s+.+$" />
```

Multiple processes can share an inbox and dispatch by subject pattern: one filter for `^Bestellung:`, another for `^Reklamation:`, a third without a pattern as the catch-all. The trigger compiles the regex once per fire, and **rejects the deploy if the pattern doesn't parse** — you find out at deploy time, not at 3am when the first non-matching mail arrives.

Before this release, the only way to drop a mail was an `onMailReceived` host callback returning `{ skip: true }` — by which point an instance was already created, attachments were already listed, and a `TERMINATE` had to clean up after itself. Subject filtering at the trigger layer is cheaper, clearer in observability, and modelable in pure BPMN.

### Multi-instance sub-processes — one node, N parallel branches

**A long-missing piece is finally in.** Multi-instance markers on `bpmn:subProcess` are now first-class. Drop `tri:multiInstanceData` on a sub-process and the engine asks your handler for the item list, fans out into one `onSubProcess` invocation per item, and only advances the parent token once **all** iterations have completed. The same semantics that have worked on `serviceTask` and `userTask` since day one — finally available on sub-processes.

```xml
<!-- One sub-process node, multiple invocations — one per resolved item. -->
<bpmn:subProcess id="Activity_Approvals" name="Collect approvals"
  acme:processRef="approval-flow"
  tri:multiInstanceData="approverList" />
```

```typescript
engine.init({
  onMultiInstanceResolve: async ({ payload }) => {
    // Return the list to fan out over. Each item produces one onSubProcess call.
    return { items: await myDb.approversFor(payload.instanceId) };
  },
  onSubProcess: async ({ instanceId, payload }) => {
    // executionIndex / loopCounter / totalItems tell you which slot you are.
    const approvers = await myDb.approversFor(instanceId);
    const handle = await myDispatcher.start('approval-flow', {
      approver: approvers[payload.executionIndex!],
    });
    await myLinkTable.insert({
      parentInstanceId: instanceId,
      parentWorkItemId: payload.workItemId,
      childHandle: handle,
    });
  },
});
```

The flow is the familiar MI shape: one `CALLBACK_MULTI_INSTANCE_RESOLVE` lands first, your handler returns the items, then the engine emits N `CALLBACK_WORK` callbacks with `kind: 'subProcess'`, each carrying `executionIndex`, `loopCounter`, and `totalItems`. Every iteration completes its own work item via `completeExternalTask`. When the last completion arrives, the parent token advances — **no manual join logic on your side, no counter you have to maintain.** Sequential vs. parallel is your call: complete iterations in order for sequential semantics, fire them off concurrently otherwise. The engine doesn't constrain timing — it just guards the count.

### Pluggable sub-processes — call out to anything, the engine keeps the books

**The body of a `bpmn:subProcess` no longer has to live in the same BPMN file.** When a sub-process element carries extensions but no inner start event, in-concert treats it as an opaque pointer to *something the host knows how to invoke* and emits a new `onSubProcess` callback. You decide what the pointer means: another deployed in-concert process, an external workflow service, a serverless step function, a third-party orchestrator, a human-approval queue, a long-running async job. Anything that eventually says "done" through `completeExternalTask()`.

```xml
<!-- A sub-process with no inner body — just attributes your handler understands. -->
<bpmn:subProcess id="Activity_Resolve" name="Resolve incident"
  acme:processRef="incident-resolution-v3"
  acme:priority="P1" />
```

```typescript
engine.init({
  onSubProcess: async ({ instanceId, payload }) => {
    const ref = payload.extensions?.['acme:processRef'];
    const priority = payload.extensions?.['acme:priority'];

    // You decide what "invoke" means. Start a child process in another
    // engine, hit a webhook, enqueue work, page an operator — whatever.
    // The engine doesn't care.
    const handle = await myDispatcher.start(ref, { priority });

    // Record the linkage somewhere you control, so you can complete the
    // parent when the work finishes:
    await myLinkTable.insert({
      parentInstanceId: instanceId,
      parentWorkItemId: payload.workItemId,
      childHandle: handle,
    });

    // Don't complete here — the parent stays paused.
  },
});
```

Minutes, hours, or days later, when the work finishes — look up the parent and resume:

```typescript
// From your own listener / poller / webhook — whatever fits the thing you dispatched to.
await engine.completeExternalTask(parentInstanceId, parentWorkItemId, { output });
```

The parent picks up exactly where it left off. Crucially, **the engine doesn't shed responsibility just because you took over dispatch.** The parent token sits in `WAITING`. A `SUB_PROCESS` work item is recorded in `waits.workItems`. The event log captures `WORK_ITEM_CREATED` for the dispatch. If your process crashes between the child finishing and `completeExternalTask` returning, the work item is still `IN_PROGRESS` in the database — your own boot-time reconcile replays it. **Durability stays with the engine; flexibility goes to you.**

Embedded sub-processes (with an inner start event) keep working the same way — the engine walks them internally as it always did. The new callback fires *only* for sub-process elements that have no inner body and carry extensions, so every existing model is unchanged. [Full sub-process guide](./docs/sdk/usage.md)

### Singleton engine worker — one claim loop, no races

**Breaking change in local mode.** Every entry point that advanced a process — `run()`, `recover()`, the trigger scheduler, the outbox dispatcher — used to own its own claim loop against the continuation queue. Under load, two loops live at once could race for the same row; the engine's version-conflict path handled it correctly on paper, but the races surfaced in the wild as duplicate callbacks, missed dispatches, and intermittent test failures that *looked* like engine bugs and weren't.

The new release collapses all claim-and-dispatch into **one worker per client**, subscribed to a Mongo change stream for low-latency delivery and a fallback poll for delayed work and stream gaps. `run(instanceId)` no longer claims — it registers a waiter with the worker and awaits the quiescence signal. No read-after-write games, no exclusion lists, no simultaneous claimers.

```typescript
// Before (0.3.x and earlier):
engine.init({ onServiceCall, onWorkItem, onDecision });
await engine.run(instanceId);

// After (current):
engine.init({ onServiceCall, onWorkItem, onDecision });
engine.startEngineWorker();         // ← required before run() in local mode
await engine.run(instanceId);
// graceful shutdown:
await engine.stopEngineWorker();
```

REST mode is unaffected — the in-concert server runs its own worker. The legacy `processUntilComplete()` still works for self-contained test scripts and tools that don't want a long-lived worker. The two patterns must not be mixed on the same instance in the same process. [Full migration + reference](./docs/sdk/usage.md#recoveroptions)

### Transparent engine — your BPMN extension attributes flow straight to your plugins

**What stayed hard-coded inside the library for too long now belongs to the plugin.** Before this release, adding a new extension attribute to your BPMN — or an entirely new start-trigger type — meant cutting a library release: the parser knew the attribute names, the deploy path knew how to reshape them, the SDK's `extractEvents` had a hard-coded `'timer' | 'connector'` split. That's gone.

The engine's parser now emits **raw attribute bags** — `node.selfAttrs` and `node.messageAttrs` — pulled verbatim from the BPMN. Each `StartTrigger` plugin implements a new `claimFromBpmn(event)` method and decides for itself whether it owns a given start event and what config it wants stored. Deploy iterates start events × registered plugins; first non-null claim wins. **The library never interprets an extension attribute — your plugins do, using whatever vocabulary your organization prefers.**

```xml
<!-- The built-in triggers use the `tri:` namespace as TRI's own
     convention. Your own triggers can define any attribute names they
     want — the engine treats them as opaque strings and hands them to
     whichever plugin claims the start event. -->
<bpmn:message id="Msg_Escalation" name="acme-escalation"
  acme:connectorType="acme-pagerduty"
  acme:serviceKey="svc_abc123"
  acme:severity="critical" />
```

```typescript
class AcmePagerDutyTrigger implements StartTrigger {
  readonly triggerType = 'acme-pagerduty';
  readonly deployStatus = 'PAUSED';

  // Plugin owns the recognition rule AND the attribute vocabulary.
  // The engine just hands you whatever attributes it found on the BPMN;
  // you pick which ones mean "this is mine" and which become config.
  claimFromBpmn(event): BpmnClaim | null {
    if (event.eventDefinitionKind !== 'message') return null;
    if (event.messageAttrs?.['acme:connectorType'] !== 'acme-pagerduty') return null;
    return { config: stripPrefix(event.messageAttrs, 'acme:', ['connectorType']) };
  }

  // ...validate, nextSchedule, fire — same as today
}
```

Register it and ship. **No in-concert release required.** A new attribute on an existing trigger? Plugin change only. A new trigger entirely? Plugin change only. The editor side is independent too — it declares its own `bpmn-moddle` extensions for round-trip serialisation, and those names never cross into the engine.

The four built-in triggers (timer, graph-mailbox, sharepoint-folder, ai-listener) are the first consumers of the new contract and ship alongside the engine strictly as convenience — they happen to use the `tri:` namespace for their own attributes, but there's no special treatment in the core, and host apps are free to drop any of them. A companion `test/decoupling/engine-isolation.test.ts` guards the property in CI: if a file outside the documented allowlist references a specific trigger type or a hard-coded attribute name, the build fails.

**Breaking change in 0.2.0:** `StartTrigger.claimFromBpmn` is required on the plugin interface, and `extractEvents` now returns `{ nodeId, triggerType, config }[]`. Migration is a ~15-line addition per plugin. [Full plugin guide](./docs/sdk/custom-triggers.md)

### AI-listening processes — let an LLM decide when to wake up

**A new kind of start event.** An `ai-listener` trigger polls an MCP-style tool, hands the result to an LLM together with a prompt authored directly in the BPMN, and starts a process instance only when the LLM answers *"yes"*. The business rule — *how to interpret the signal* — lives in the prompt, not in code.

```xml
<bpmn:message id="Msg_RainAlert" name="ai-rain-alert"
  tri:connectorType="ai-listener"
  tri:toolEndpoint="https://weather.example.com/tools/call"
  tri:tool="get_weather"
  tri:llmEndpoint="https://llm.example.com/evaluate"
  tri:prompt="Given this observation, is it currently raining heavily enough to halt outdoor ops? Answer strictly yes or no."
  tri:pollIntervalSeconds="300" />
```

Weather alerts. Price-movement watches. System-health escalations. Fraud-signal triage. Anything where *an LLM would know* whether the current state warrants a process — and where encoding that rule in code would require pages of thresholds, exceptions, and edge cases. Write the rule once, in English, on the BPMN.

**Exactly-once out of the box.** The dedup key comes from either a `correlationId` the LLM supplies (naming the ongoing *event*) or a hash of the tool output (naming the *observation*). Repeat detections collapse to a single process instance automatically — no "am I already handling this?" bookkeeping in your handlers.

**Real LLM, real tool, zero lock-in.** The default flow is plain HTTP — any MCP-compatible tool server, any LLM with a `{ prompt, context } → { answer }` endpoint. Prefer Anthropic's SDK directly? Inject `setEvaluate(...)` on the plugin and bypass HTTP entirely. [Full AI-listener guide](./docs/sdk/usage.md#ai-listener-start-events)

### Unified start triggers — plus SharePoint folder events

**Start a process from anything.** Timers, Microsoft 365 mailboxes, SharePoint folders, and AI-listener agents are all implementations of a single `StartTrigger` plugin interface. The engine core contains zero references to specific trigger types — register the ones you want, write your own, or strip out the ones you don't need.

**SharePoint folder triggers are new:** drop a file into a watched SharePoint folder and the engine starts a process with the file's metadata as initial variables. Uses the Graph `/delta` API — no full folder scans, no duplicate starts, no "mark as processed" dance.

```xml
<bpmn:message id="Msg_NewOrder" name="incoming-orders"
  tri:connectorType="sharepoint-folder"
  tri:siteUrl="https://contoso.sharepoint.com/sites/Ops"
  tri:folderPath="/Incoming/Orders"
  tri:fileNamePattern="*.pdf"
  tri:initialPolicy="skip-existing" />
```

Timer start events (ISO 8601, cron, RRULE, date-times, durations) and Microsoft 365 mailbox polling ship as first-party trigger plugins too — the same interface your own triggers would use. An S3 bucket watcher, an SQS queue, a webhook receiver — roughly 100 lines of code against a documented interface, registered at engine init. Exactly-once instance creation is built into the framework via stable dedup keys, not implemented separately by each trigger. [Full trigger guide](./docs/sdk/custom-triggers.md)

### Enhanced recovery semantics — processes survive crashes

**Server restart? Your processes come back.** in-concert now ships with a first-class crash-recovery entry point: call `recover()` once at startup, and the engine restores every in-flight process from the previous run — quiescent instances come back untouched, mid-step transitions are replayed, and callbacks that were persisted-but-not-delivered are re-handed to your `onServiceCall`, `onWorkItem`, and `onDecision` handlers.

```typescript
const engine = getBpmEngineClient();
engine.init({ onServiceCall, onWorkItem, onDecision });
await engine.recover();   // survive crashes from prior runs
```

No polling, no bespoke resumption logic, no lost work. The new documentation includes a **crash-survival table from the developer's perspective** — what a restart means for waiting instances, in-flight tasks, pending callbacks, timers, and email-triggered starts — so you can reason about failure modes without reading engine internals. [Full recovery guide](./docs/sdk/usage.md#recoveroptions)

### Purge a process instance and its full transitive closure

Clean up a process instance — and every descendant instance spawned through call activities — in one call. `DELETE /v1/instances/:instanceId` (or `client.purgeInstance(instanceId)`) walks the `parentInstanceId` chain and removes all dependent rows from `ProcessInstance`, `ProcessInstanceState`, `ProcessInstanceEvent`, `ProcessInstanceHistory`, `Continuation`, `Outbox`, and `HumanTask`. Definition-scoped collections (process definitions, timer and connector schedules) are left untouched. [Full documentation](./docs/sdk/usage.md#purgeinstanceinstanceid)

### RRULE recurrence — full calendar-style scheduling

Timer start events now support **RFC 5545 RRULE expressions**, bringing Outlook-style recurrence patterns to BPMN process scheduling. Define schedules that cron simply cannot express:

```xml
<bpmn:startEvent id="TimerStart" name="Last Friday of every month">
  <bpmn:timerEventDefinition>
    <bpmn:timeCycle>DTSTART:20260130T090000Z
RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1</bpmn:timeCycle>
  </bpmn:timerEventDefinition>
</bpmn:startEvent>
```

Every 3 days. Every 2 weeks on Monday and Friday. The second Tuesday of every month. The last weekday of each quarter. **Any pattern you can define in a calendar invitation, you can now use to schedule a process.** `FREQ`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `COUNT`, and `UNTIL` are all supported — zero external dependencies.

RRULE joins the existing timer expressions (ISO 8601 intervals, cron, date-times, durations) so nothing breaks. [Full RRULE documentation](./docs/sdk/usage.md#rrule-recurrence-rules-rfc-5545)

---

## What is this?

**in-concert** executes **BPMN 2.0 process definitions** in Node.js. It is not a visual modeler or a full Camunda/Flowable replacement — it is a focused, embeddable runtime that covers the BPMN subset most production workflows actually need.

```
BPMN file ──▶ in-concert ──▶ Event-sourced instance
                   │
                   ├── REST + WebSocket (microservice mode)
                   └── Local MongoDB   (embedded / test mode)
```

Built for teams who want **deterministic, inspectable process execution** without the weight of a full BPM platform.

> **Powered by [The Real Insight GmbH](https://the-real-insight.com)**

---

## Highlights

| | |
|---|---|
| 🔁 **Event-sourced instances** | Every token move is an event. Replay, audit, and debug any instance from its stream. |
| ⚡ **Optimistic concurrency** | Safe parallel execution without pessimistic locking. |
| 📬 **Push-style callbacks** | Human tasks, service tasks, and gateway decisions delivered via WebSocket — no polling. |
| 🔌 **Two integration modes** | **REST mode** (HTTP + WebSocket) for microservices, **local mode** (direct MongoDB) for tests and embedding. |
| 📋 **Worklist built in** | Human tasks projected to `/v1/tasks` with claim, activate, and complete flows out of the box. |
| 🎯 **Honest scope** | A [well-defined BPMN subset](./readme/REQUIREMENTS.md) — no hidden surprises, no partially-supported elements. |

---

## A real process, running live

The diagram below is a working BPMN 2.0 process executed by in-concert. It calls the NASA Near-Earth Object API, routes on the result through an XOR gateway, and hands off to a human reviewer when a hazardous object is detected — all with your logic, your storage, and your services wired in from outside the engine.

![NEO Watch — NASA asteroid hazard workflow](./docs/neo-bpmn.svg)

→ [Full walkthrough with code](./docs/getting-started.md)

---

## Quick Start

**Prerequisites:** Node.js 18+, MongoDB

```bash
npm install @the-real-insight/in-concert
```

in-concert supports two integration modes. The API is identical — only initialisation differs.

**Remote mode** is the right choice when you want to scale the engine independently as a microservice, share it across multiple applications, or keep process execution decoupled from your business logic. The engine runs as a standalone HTTP + WebSocket server; your application connects via the SDK.

**Server side** — the engine exposes a REST API and a WebSocket endpoint. Configure it via environment variables and start it with Node:

```bash
# .env
MONGO_URL=mongodb://localhost:27017
MONGO_BPM_DB=in-concert
PORT=3000
```

```bash
node node_modules/@the-real-insight/in-concert/dist/index.js
```

The engine is now listening on `:3000` — REST API under `/v1`, WebSocket at `/ws`.

**Client side** — connect from any Node.js application using the SDK:

```typescript
import { BpmnEngineClient } from '@the-real-insight/in-concert/sdk';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});
```

Alternatively, **local mode** embeds the engine directly in your process — no server, no network hop. It runs against MongoDB in-process, which makes it ideal for testing, serverless functions, or applications where co-location matters more than scale-out.

You can initialise for embedded use like this:

```typescript
import { BpmnEngineClient } from '@the-real-insight/in-concert/sdk';
import { connectDb, ensureIndexes } from '@the-real-insight/in-concert/db';

const db = await connectDb('mongodb://localhost:27017/in-concert');
await ensureIndexes(db);

const client = new BpmnEngineClient({ mode: 'local', db });
```

### Handlers — keeping your logic outside the engine

in-concert does not execute your business logic. Instead, it notifies your code when the process needs something, and waits. This is a deliberate design choice: your data, your documents, your services, and your routing decisions all live outside the engine. The process instance id is the binding key — use it to correlate any external state.

This means your handlers can do anything: make a REST call, publish to a message queue and await the reply, poll an external system, query your own database to evaluate a condition, or map data from your domain model into the result. The engine does not care how long it takes or how you get there.

Register your handlers once at startup:

```typescript
client.init({
  // Called when a service task is reached.
  // Your code calls the service — sync, async, queue-based, whatever fits.
  // Use instanceId to bind results back to this process instance.
  onServiceCall: async ({ instanceId, payload }) => {
    const result = await myService.execute(payload.extensions?.toolId, {
      processInstanceId: instanceId,
      ...myDataStore.getContextFor(instanceId),
    });
    await client.completeExternalTask(instanceId, payload.workItemId, { result });
  },

  // Called when an XOR gateway needs a routing decision.
  // Evaluate the condition in your own code, against your own data.
  // The engine never sees your domain objects — only the selected flow id.
  onDecision: async ({ instanceId, payload }) => {
    const context = await myDataStore.getContextFor(instanceId);
    const selected = myRouter.evaluate(payload.transitions, context);
    await client.submitDecision(instanceId, payload.decisionId, {
      selectedFlowIds: [selected.flowId],
    });
  },
});

// Deploy a BPMN definition
const { definitionId } = await client.deploy({
  id: 'order-process',
  name: 'Order Process',
  version: '1',
  bpmnXml: myBpmnXml,
});

// Start an instance
const { instanceId } = await client.startInstance({
  commandId: crypto.randomUUID(),
  definitionId,
});

// REST mode: subscribe via WebSocket — no polling
client.subscribeToCallbacks((item) => console.log(item.kind, item.instanceId));

// Local mode: run to completion inline
const { status } = await client.run(instanceId);
console.log(status); // COMPLETED | FAILED | TERMINATED
```

### Worklist — building task-driven UIs

in-concert projects human tasks into a queryable worklist, giving you the flexibility to build any interaction model your product needs. Tasks can be filtered by role, by the user who has claimed them, by process instance, or by status — so you can support cherry-picking (users browse open tasks and self-assign), supervisor assignment (a manager picks who does what), or fully automated routing.

**Fetching tasks for a user** returns all open tasks matching that user's roles, plus any tasks they have already claimed:

```typescript
const tasks = await client.getWorklistForUser({
  userId: user._id,
  roleIds: user.roleAssignments.map(ra => String(ra.role)),
});
```

**Claiming a task** locks it for that user, preventing others from picking it up simultaneously:

```typescript
await client.activateTask(taskId, { userId: user._id });
```

You can also query more broadly — by instance, status, or assignee — to build supervisor views or audit dashboards:

```typescript
const allOpen    = await client.listTasks({ status: 'OPEN' });
const myInstance = await client.listTasks({ instanceId });
const claimedBy  = await client.listTasks({ userId: user._id });
```

**Completing a task** advances the process. Pass the result and user for a full audit trail:

```typescript
await client.completeUserTask(instanceId, workItemId, {
  result: { approved: true, comment: 'Looks good' },
  user: { email: user.email },
});
```

> Full API reference → [SDK usage guide](./docs/sdk/usage.md)

### See it all in action

The [NASA Near-Earth Object Watch](./docs/getting-started.md) is a complete, copy-paste-ready example that wires up every concept above in a single file: a live NASA API call, an XOR gateway routing on the result, an astronomer review task working through the worklist, and a full audit trail. If you want to understand how in-concert fits together in practice, start there.

---

## Test portal

The engine ships with a browser-based **process portal** for hands-on testing. Deploy a process, start instances, claim and complete human tasks, and inspect the full event history — no application code required.

```bash
npm run server
# opens at http://localhost:9100
```

![Process portal — NEO Watch running with worklist, active task, and event history](./docs/portal/neo/process-history.png)

The portal shows the complete interaction cycle: start a process (top), claim tasks from the worklist (left), complete them with a response and optional file attachments (centre), and trace every engine event in the process history (right). It is the fastest way to verify a BPMN model end-to-end before wiring up integrations.

Step-by-step walkthrough with the NEO Watch process: [Getting started — Test portal](./docs/getting-started.md#running-the-process-in-the-test-portal)

---

## HTTP API

The engine exposes a REST API under `/v1`. Key endpoints:

```
POST   /v1/definitions                              Deploy a BPMN file
POST   /v1/instances                                Start a process instance
GET    /v1/instances/:id                            Get instance
DELETE /v1/instances/:id                            Purge instance and child-instance closure
GET    /v1/instances/:id/state                      Get execution state
POST   /v1/instances/:id/work-items/:wid/complete   Complete a work item
POST   /v1/instances/:id/decisions/:did             Resolve an XOR gateway
GET    /v1/tasks                                    Worklist query
GET    /v1/timer-schedules                          List timer schedules
POST   /v1/timer-schedules/:id/pause                Pause a timer
POST   /v1/timer-schedules/:id/resume               Resume a timer
GET    /v1/connector-schedules                      List connector schedules
POST   /v1/connector-schedules/:id/pause            Pause a connector
POST   /v1/connector-schedules/:id/resume           Resume a connector
PUT    /v1/connector-schedules/:id/credentials      Set per-schedule credentials
POST   /v1/definitions/:id/schedules/activate       Activate all schedules for a definition
POST   /v1/definitions/:id/schedules/deactivate     Deactivate all schedules for a definition
WS     /ws                                          Push callbacks (REST mode)
```

Full reference → [SDK usage guide](./docs/sdk/usage.md)

---

## Documentation

| Guide | Description |
|---|---|
| [Getting started](./docs/getting-started.md) | Environment setup, ports, install, test commands |
| [SDK overview](./docs/sdk/README.md) | Entry points, REST vs local mode, `TriSdk` facade |
| [SDK usage (full reference)](./docs/sdk/usage.md) | API reference, callbacks, WebSocket, worklist |
| [Browser demo](./docs/test-ui.md) | Interactive test UI (`npm run server`) |
| [Testing](./docs/testing.md) | Jest targets and conformance pointers |
| [Database schema](./docs/database-schema.md) | MongoDB hub; canonical tables in `readme/database-schema.md` |
| [Contributing](./docs/contributing.md) | How to contribute |

Design & internals:

- [BPMN subset & requirements](./readme/REQUIREMENTS.md)
- [MongoDB database schema](./readme/database-schema.md) — collections, fields, types, semantics, indexes
- [Conformance matrix](./readme/TEST.md)

---

## BPMN Support

in-concert implements a curated BPMN 2.0 subset. See the full [conformance matrix](./readme/TEST.md) for details. Unsupported elements fail fast and loudly — never silently.

**Supported:** Start/End events · Timer start events (cron, ISO 8601, RRULE) · Message start events (Graph mailbox polling) · Service tasks · User tasks · Script tasks · XOR gateways · Parallel gateways · Sequence flows · Boundary events · Sub-processes

**Not in scope (yet):** Compensation · Complex gateways · Choreography · Conversation

**<span style="color:red">Want these to be added? [Contribute!](./docs/contributing.md)</span>**

---

## Contributing

Issues and pull requests are welcome. Please read [docs/contributing.md](./docs/contributing.md) and run tests before submitting:

```bash
npm run test:unit          # fast unit tests
npm run test:conformance   # BPMN conformance suite
```

---

## License

Copyright © 2024-present **[The Real Insight GmbH](https://the-real-insight.com)**

This project is released under a **modified MIT license with attribution requirements**. See [LICENSE](./LICENSE) for the full text.

**In short:** You may use, copy, modify, and distribute this software freely — with three conditions:

> 1. The engine's **startup log notice** identifying The Real Insight GmbH must not be removed or suppressed.
> 2. Any **end-user product** built on this engine must credit The Real Insight GmbH in its imprint, About page, or terms and conditions.
> 3. Any **documentation or README** accompanying a derivative must include a "Powered by" attribution.

---

<div align="center">

Built with care by **[The Real Insight GmbH](https://the-real-insight.com)**

*The creators of Agentic BPM.*

</div>