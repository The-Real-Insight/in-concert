# tri-bpmn-engine

A **BPMN 2.0 subset** execution engine for **Node.js**, with **event-sourced** process instances, **optimistic concurrency**, and **push-style callbacks** for human tasks, service tasks, and external gateway decisions. Use it as an **HTTP service** (REST + WebSocket) or embed it in **local mode** against MongoDB.

**npm package:** [`@the-real-insight/tri-bpmn-engine`](https://www.npmjs.com/package/@the-real-insight/tri-bpmn-engine)

---

## Why this project

- **Deterministic execution** — token flow, joins, and recorded decisions; replay-friendly event stream per instance.  
- **Two integration styles** — **REST** (`BpmnEngineClient` + `/ws`) for microservices, or **local** (`BpmnEngineClient` + `mongodb` `Db`) for tests and embedded use.  
- **Worklist-ready** — human tasks projected to **`/v1/tasks`** with claim, activate, and complete flows; optional **`TriSdk`** facade for engine + tasks in one object.  
- **Honest scope** — implements a defined BPMN subset (see [requirements](readme/REQUIREMENTS.md)); not a full Camunda/Flowable replacement.

---

## Quick start

**Prerequisites:** Node.js 18+, MongoDB.

```bash
git clone <repository-url>
cd tri-bpmn-engine
npm install
cp .env.example .env
# Set MONGO_URL in .env if needed
```

**Run the engine** (API + worker + WebSocket on port 3000 by default):

```bash
npm run dev
```

**Run the browser demo** (interactive test UI; default port **9100** in `npm run server`):

```bash
npm run server
# Open http://localhost:9100/
```

**Use from your app:**

```bash
npm install @the-real-insight/tri-bpmn-engine
```

```typescript
import { BpmnEngineClient } from '@the-real-insight/tri-bpmn-engine/sdk';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});

// deploy, startInstance, getState, completeUserTask, subscribeToCallbacks, …
```

More examples, local mode, `init`, and worklist patterns are in the **[documentation](#documentation)**.

---

## Documentation

| | |
|---|---|
| **[Documentation home](docs/README.md)** | Index of all guides |
| **[Getting started](docs/getting-started.md)** | Environment, ports, install, test commands |
| **[SDK overview](docs/sdk/README.md)** | Entry points, REST vs local, `TriSdk` |
| **[SDK usage (full reference)](docs/sdk/usage.md)** | API reference, callbacks, WebSocket, worklist |
| **[Browser demo (test UI)](docs/test-ui.md)** | Demo server features and layout |
| **[Testing](docs/testing.md)** | Jest targets and conformance pointers |
| **[Contributing](docs/contributing.md)** | How to contribute and project expectations |

Design depth:

- [Requirements & BPMN subset](readme/REQUIREMENTS.md)  
- [Implementation notes (MongoDB)](readme/IMPLEMENTATION.md)  
- [Conformance matrix (table)](readme/TEST.md)  

---

## HTTP API (sketch)

Typical **`/v1`** operations (see SDK and server routes for full detail):

- `POST /v1/definitions` — deploy BPMN  
- `POST /v1/instances` — start instance  
- `GET /v1/instances/:id` / `.../state` — inspect instance  
- `POST /v1/instances/:id/work-items/:workItemId/complete` — complete work  
- `POST /v1/instances/:id/decisions/:decisionId` — XOR / external decision  
- `GET /v1/tasks` — worklist query  
- WebSocket **`/ws`** — `CALLBACK_WORK` / `CALLBACK_DECISION` push (REST mode SDK)

---

## Contributing

We welcome issues and pull requests. Please read **[docs/contributing.md](docs/contributing.md)** and run **`npm run test:unit`** (plus SDK/conformance tests when you touch runtime code) before submitting.

---

## License

License terms are specified in **`package.json`** (`license` field). If you need OSS-friendly licensing for redistribution, open an issue so maintainers can align on a standard license file.

---

## Publishing note

CI may bump versions and publish to npm on pushes to the default branch; configure **`NPM_TOKEN`** in GitHub Actions secrets as described in your workflow files.
