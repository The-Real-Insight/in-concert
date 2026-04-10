# Getting started

## Prerequisites

- **Node.js** 18 or newer  
- **MongoDB** reachable from your machine (local or remote)  
- **npm** (or another client compatible with `package.json` scripts)

## Clone and install

```bash
git clone <repository-url>
cd tri-bpmn-engine
npm install
```

## Configuration

Copy the environment template and adjust MongoDB (and optional ports):

```bash
cp .env.example .env
```

Typical variables:

| Variable | Purpose |
|----------|---------|
| `MONGO_URL` | MongoDB connection string (default in code: `mongodb://localhost:27017/tri-bpmn-engine`) |
| `MONGO_DB` / `MONGO_BPM_DB` | Database names for BPM data (see `src/config.ts`) |
| `PORT` | HTTP port for the engine API (`npm run dev` defaults to **3000**) |

The **browser demo** (`npm run server`) sets `PORT=9100` in `package.json` unless you override it.

## Run the engine (HTTP + WebSocket)

Production-style API server with worker loop:

```bash
npm run dev
```

- REST API under `/v1/...`  
- WebSocket callbacks at `/ws` (used by the SDK in REST mode)

## Run the browser demo (test UI)

Interactive UI for starting processes, worklist, and history (see [test-ui.md](test-ui.md)):

```bash
npm run server
```

Open **http://localhost:9100/** unless you changed `PORT`.

## Use the SDK from another project

```bash
npm install @the-real-insight/tri-bpmn-engine
```

Then follow [SDK overview](sdk/README.md) and the [full usage guide](sdk/usage.md).

## Run tests

See [testing.md](testing.md) for all targets. Common commands:

```bash
npm test                    # full suite (includes conformance where applicable)
npm run test:unit           # fast unit tests, no MongoDB
npm run test:sdk            # SDK integration tests (MongoDB)
npm run test:conformance    # BPMN conformance (MongoDB)
```

## Next steps

- [SDK overview](sdk/README.md) — how to embed or call the engine  
- [Browser demo](test-ui.md) — explore behavior without writing code first  
- [Contributing](contributing.md) — issues, PRs, and conventions  
