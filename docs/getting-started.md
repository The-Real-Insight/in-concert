# Getting started

This page explains **what you actually do** with tri-bpmn-engine: deploy a process model, start runs, handle **human work** through a **worklist**, and handle **automation** by reacting to **service-task callbacks** (for example by calling a public REST API yourself).

---

## The use case in one picture

Imagine a small process for a **launch checklist**:

1. A **user task** — an operator enters a callsign in a UI (worklist).  
2. A **service task** — your integration code calls a **public REST API** (no API keys) to fetch live data, then tells the engine the step is done.  
3. Another **user task** — a lead reviews the result and approves.

The engine does **not** execute JavaScript inside the diagram and does **not** magically call external URLs. It **orchestrates**: it moves tokens, records events, creates **work items** for people, and emits **callbacks** so *your* code runs service work and reports back. That split is what makes the model portable (BPMN XML) and the integrations testable (plain HTTP + your handlers).

---

## Step 0 — Nothing runs without a deployed model

Before you can start a process instance, the engine must know the **process definition**: the normalized graph derived from your **BPMN 2.0 XML**.

- **Deploy** = register that XML once (per id/version). You get a `definitionId` (or equivalent) to use when starting instances.  
- **Start instance** = create a new run of an already deployed definition.  
- **Worklist** = query open **user tasks** (and related operations) while the instance is `RUNNING`.  
- **Service tasks** = the engine **pauses** and notifies you via **callback** (WebSocket in REST mode, or your handler in local mode); **you** perform the side effect (e.g. `fetch` to a REST API) and then **complete** the work item.

If you skip deployment, `startInstance` has nothing valid to point at.

---

## Authoring the model: bpmn.io

Most teams **draw** BPMN in a visual editor and export **XML**.

**[bpmn.io](https://bpmn.io/)** is the open-source project behind the popular **BPMN toolkit** used in many products (including Camunda’s web Modeler). It provides embeddable modeling components and a polished **online demo** where you can sketch pools, lanes, user tasks, service tasks, gateways, and sequence flows—then **download BPMN 2.0 XML** for your app.

- **Project & docs:** [bpmn.io](https://bpmn.io/)  
- **Try the modeler in the browser:** [demo.bpmn.io](https://demo.bpmn.io/)

Export your diagram as `.bpmn` / XML. The engine supports a **defined subset** of BPMN (see [requirements & subset](../readme/REQUIREMENTS.md)); start with **start event → user tasks / service tasks → end event** before adding XOR/AND gateways.

---

## Example process: “ISS briefing” (conceptual BPMN)

**Story:** After an operator enters a **callsign** (user task), automation **fetches the current ISS position** from a **public JSON API** (service task). A **flight director** then confirms “go” or “no-go” (user task).

**Sequence:** `Start` → `Enter callsign` *(userTask)* → `Fetch ISS position` *(serviceTask)* → `Go / no-go` *(userTask)* → `End`

A similar **three-step** shape (user → service → user) exists in the repo as `test/bpmn/linear-service-and-user-task.bpmn`—handy if you want a file to open in [demo.bpmn.io](https://demo.bpmn.io/) and adapt.

**Public REST endpoint for the story** (no auth, GET, JSON):  
[https://api.open-notify.org/iss-now.json](https://api.open-notify.org/iss-now.json) — returns the International Space Station’s current latitude/longitude. Your service-task handler can `fetch` this URL, optionally store part of the JSON in the **completion payload**, and call the engine’s complete API.

---

## Run the engine on your machine

**Prerequisites:** Node.js 18+, MongoDB.

```bash
git clone <repository-url>
cd tri-bpmn-engine
npm install
cp .env.example .env
# Set MONGO_URL if MongoDB is not the default
```

| Variable | Purpose |
|----------|---------|
| `MONGO_URL` | MongoDB connection string |
| `MONGO_DB` / `MONGO_BPM_DB` | BPM data databases (see `src/config.ts`) |
| `PORT` | HTTP port for `npm run dev` (default **3000**) |

Start the **API + worker + WebSocket** server:

```bash
npm run dev
```

- REST API: `/v1/...`  
- Callback stream (SDK): WebSocket `/ws`

For a **browser demo** (default port **9100**): `npm run server` → [http://localhost:9100/](http://localhost:9100/) — see [test-ui.md](test-ui.md).

---

## 1. Deploy the model

Register the XML once. In an **application that talks to the engine** (separate from cloning this repo), add the client:

```bash
npm install @the-real-insight/tri-bpmn-engine
```

Then deploy with the **SDK**:

```typescript
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BpmnEngineClient } from '@the-real-insight/tri-bpmn-engine/sdk';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});

const bpmnXml = readFileSync('./iss-briefing.bpmn', 'utf8');

const { definitionId } = await client.deploy({
  id: 'iss-briefing',
  name: 'IssBriefing',
  version: '1',
  bpmnXml,
  overwrite: true, // optional: replace if same id + version already deployed
});
```

Under the hood this is `POST /v1/definitions` with JSON body `{ name, version, bpmnXml, ... }`. You need the returned **`definitionId`** to start runs.

---

## 2. Start a process instance

```typescript
const { instanceId } = await client.startInstance({
  commandId: randomUUID(),
  definitionId,
});
```

Equivalent HTTP:

```bash
curl -s -X POST http://localhost:3000/v1/instances \
  -H "Content-Type: application/json" \
  -d '{
    "commandId": "550e8400-e29b-41d4-a716-446655440000",
    "definitionId": "<definitionId-from-deploy>"
  }'
```

The instance is now **running**. Tokens **wait** at **user tasks** and **service tasks** until something completes them.

---

## 3. Obtain the worklist (human tasks)

User tasks are projected into a **worklist** you can query over REST.

```bash
# Open tasks for this instance (adjust query to your needs)
curl -s "http://localhost:3000/v1/tasks?instanceId=<instanceId>&status=OPEN"
```

Typical flow for a person:

1. **List** tasks (`GET /v1/tasks`, optionally filtered by user/role).  
2. **Claim / activate** so only one person works the task (`POST /v1/tasks/:taskId/activate` with `userId` + `commandId`).  
3. **Complete** with an optional result payload (`POST /v1/tasks/:taskId/complete`).

The engine remains the source of truth; the worklist is built for **inbox UIs** and role-based routing (lanes / `tri:roleId` when you use them in BPMN). Details: [SDK usage — Worklist reference](sdk/usage.md#worklist-reference).

---

## 4. Service tasks: you run the integration (e.g. REST)

When execution hits **`Fetch ISS position`**, the engine creates a **work item** and emits a **callback** (`CALLBACK_WORK` with `kind: 'serviceTask'`). The engine does **not** perform the HTTP call for you.

**Semantics:**

1. Execution reaches the service task → work item + outbox callback.  
2. **Your worker or service** receives the callback (subscribe with the SDK over **`/ws`** in REST mode, or handle it in process in local mode).  
3. You do the real work—here, call the public API:

   ```typescript
   const res = await fetch('https://api.open-notify.org/iss-now.json');
   const data = await res.json();
   ```

4. You tell the engine the step finished (reuse `randomUUID` from `node:crypto` as in deploy/start above):

   ```typescript
   await client.completeExternalTask(instanceId, workItemId, {
     commandId: randomUUID(),
     result: { issPosition: data.iss_position },
   });
   ```

After that, the worker advances the token to the next node (e.g. the **Go / no-go** user task), and the worklist updates accordingly.

So: **service task = “your code’s turn,”** often wrapping **REST**, queues, or internal libraries—always ending in **`completeExternalTask`** (or the equivalent REST path for work items).

Full callback and WebSocket details: [SDK usage — Callbacks](sdk/usage.md#callbacks-for-user-tasks-and-service-tasks).

---

## Wire the service task: subscribe and complete

Using the same **`BpmnEngineClient`** instance (after **`npm install @the-real-insight/tri-bpmn-engine`**), connect **`subscribeToCallbacks`** so every **`CALLBACK_WORK`** for a **service task** triggers your REST call and completion (user tasks are usually **not** completed here—you route those to the worklist UI):

```typescript
import { randomUUID } from 'node:crypto';
import { BpmnEngineClient } from '@the-real-insight/tri-bpmn-engine/sdk';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});

client.subscribeToCallbacks((item) => {
  if (item.kind !== 'CALLBACK_WORK') return;
  const p = item.payload;
  if (p.kind !== 'serviceTask') return;

  void (async () => {
    const res = await fetch('https://api.open-notify.org/iss-now.json');
    const data = (await res.json()) as { iss_position?: { latitude: number; longitude: number } };
    await client.completeExternalTask(p.instanceId, p.workItemId, {
      commandId: randomUUID(),
      result: { issPosition: data.iss_position },
    });
  })().catch(console.error);
});
```

Pair this with **`GET /v1/tasks`** (or **`TriSdk`** — [SDK overview](sdk/README.md)) so operators see and complete **user tasks** while your worker handles **service tasks**.

---

## Run tests

See [testing.md](testing.md). Quick checks:

```bash
npm run test:unit           # no MongoDB
npm run test:sdk            # integration (MongoDB)
npm run test:conformance    # BPMN scenarios (MongoDB)
```

---

## Next steps

- [SDK overview](sdk/README.md) — `TriSdk`, local vs REST  
- [SDK usage (full)](sdk/usage.md) — `init`, decisions, recovery  
- [Browser demo](test-ui.md) — try flows without writing a client first  
- [Contributing](contributing.md)  
