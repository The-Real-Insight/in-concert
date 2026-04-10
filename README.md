<div align="center">

<img src="./docs/banner.png" alt="in-concert logo" width="800" />

**A production-grade BPMN 2.0 execution engine for Node.js**

*Event-sourced · Optimistic concurrency · Push-style callbacks · REST & embedded*

[![npm version](https://img.shields.io/npm/v/@the-real-insight/in-concert?style=flat-square&color=0f172a&labelColor=64748b)](https://www.npmjs.com/package/@the-real-insight/in-concert)
[![License](https://img.shields.io/badge/license-TRI--MIT-0f172a?style=flat-square&labelColor=64748b)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-0f172a?style=flat-square&labelColor=64748b)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-0f172a?style=flat-square&labelColor=64748b)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/github/actions/workflow/status/The-Real-Insight/in-concert/test.yml?style=flat-square&label=tests&labelColor=64748b)](https://github.com/The-Real-Insight/in-concert/actions)

<br/>

[**Get started →**](#quick-start) · [**Documentation**](./docs/README.md) · [**npm**](https://www.npmjs.com/package/@the-real-insight/in-concert) · [**Contributing**](./docs/contributing.md)

</div>

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

## Quick Start

**Prerequisites:** Node.js 18+, MongoDB

### Run as a service

```bash
git clone https://github.com/The-Real-Insight/in-concert.git
cd in-concert
npm install
cp .env.example .env          # set MONGO_URL if needed
npm run dev                   # API + worker + WebSocket on :3000
```

### Install the SDK

```bash
npm install @the-real-insight/in-concert
```

### Connect from your app

```typescript
import { BpmnEngineClient } from '@the-real-insight/in-concert/sdk';

// REST mode — connects to a running in-concert service
const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});

// Deploy a process definition
await client.deployDefinition({ bpmnXml: myBpmnXml });

// Start an instance
const { instanceId } = await client.startInstance({
  processId: 'my-process',
  variables: { orderId: '42' },
});

// Subscribe to push callbacks (human tasks, service tasks, decisions)
client.subscribeToCallbacks(instanceId, async (callback) => {
  if (callback.type === 'CALLBACK_WORK') {
    await client.completeUserTask(instanceId, callback.workItemId, { approved: true });
  }
});
```

> **Embedded / local mode** (direct MongoDB, no HTTP) is documented in [SDK overview →](./docs/sdk/README.md)

---

## HTTP API

The engine exposes a REST API under `/v1`. Key endpoints:

```
POST   /v1/definitions                              Deploy a BPMN file
POST   /v1/instances                                Start a process instance
GET    /v1/instances/:id                            Get instance
GET    /v1/instances/:id/state                      Get execution state
POST   /v1/instances/:id/work-items/:wid/complete   Complete a work item
POST   /v1/instances/:id/decisions/:did             Resolve an XOR gateway
GET    /v1/tasks                                    Worklist query
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
| [Contributing](./docs/contributing.md) | How to contribute |

Design & internals:

- [BPMN subset & requirements](./readme/REQUIREMENTS.md)
- [Implementation notes (MongoDB)](./readme/IMPLEMENTATION.md)
- [Conformance matrix](./readme/TEST.md)

---

## BPMN Support

in-concert implements a curated BPMN 2.0 subset. See the full [conformance matrix](./readme/TEST.md) for details. Unsupported elements fail fast and loudly — never silently.

**Supported:** Start/End events · Service tasks · User tasks · Script tasks · XOR gateways · Parallel gateways · Sequence flows · Boundary events · Sub-processes

**Not in scope (yet):** Compensation · Complex gateways · Choreography · Conversation

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

*Powering process automation, transparently.*

</div>