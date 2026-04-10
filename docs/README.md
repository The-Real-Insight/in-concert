# Documentation

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

Welcome to the **tri-bpmn-engine** documentation. This engine runs a carefully scoped subset of **BPMN 2.0** with **event-sourced** process instances, **optimistic concurrency**, and **push-style callbacks** (WebSocket in REST mode, in-process in local mode) for user tasks, service tasks, and external gateway decisions.

## Start here

| Document | Description |
|----------|-------------|
| [Getting started](getting-started.md) | Prerequisites, environment, run the API server, run tests |
| [Contributing](contributing.md) | How to contribute, branch workflow, and quality checks |

## SDK

| Document | Description |
|----------|-------------|
| [SDK overview](sdk/README.md) | Package entry points, `BpmnEngineClient` vs `TriSdk`, REST vs local mode |
| [Usage guide (full)](sdk/usage.md) | Install, quick start, `init`, worklist, callbacks, WebSocket, API reference |

## Test & demo UI

| Document | Description |
|----------|-------------|
| [Browser demo (test UI)](test-ui.md) | Demo server features, model sources, worklist, environment |

## Testing & conformance

| Document | Description |
|----------|-------------|
| [Testing](testing.md) | Jest targets, MongoDB requirements, conformance matrix pointer |

## Design references (repository `readme/`)

These files stay next to historical design notes and deep requirements:

- [Requirements & BPMN subset](../readme/REQUIREMENTS.md) — goals, supported elements, non-goals  
- [Implementation notes](../readme/IMPLEMENTATION.md) — MongoDB collections and indexes  
- [Conformance matrix (raw)](../readme/TEST.md) — scenario table used by conformance work  

---

**Package (npm):** `@the-real-insight/tri-bpmn-engine` — see [Getting started](getting-started.md) for install and run commands.
