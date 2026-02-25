# tri-bpmn-engine

BPMN 2.0 subset execution engine with event sourcing, optimistic concurrency, and external decision evaluation.

## Stack

- TypeScript on Node.js
- Express
- MongoDB

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and set MONGO_URL (default: mongodb://localhost:27017/tri-bpmn-engine)
```

## Run

Requires MongoDB. Then:

```bash
npm run dev
```

## Implemented

- **Model Service**: BPMN XML parsing, graph normalization
- **Runtime API**: Deploy, start instance, complete work, submit decision, query state
- **Core flow**: Start event, end event, sequence flow
- **Tasks**: Service task, user task (external callback via outbox)
- **Gateways**: XOR (split + join), AND (split + join)
- **Workers**: Claims and processes continuations; in-process polling
- **Outbox**: CALLBACK_WORK, CALLBACK_DECISION enqueued for delivery
- **WebSocket**: Push callbacks to clients at `/ws` (REST mode)
- **Event sourcing**: Append-only events per instance
- **Optimistic concurrency**: Versioned state updates

## Not yet implemented

- OR gateway (inclusive, conservative join)
- Timers (intermediate catch, boundary)
- Message events (catch, throw)
- Boundary error events
- Embedded subprocess, Call activity
- Outbox dispatcher (delivery loop)
- OR-join upstream metadata
- Full idempotency (commandId) for all mutating APIs

## API

### Deploy definition

```bash
curl -X POST http://localhost:3000/v1/definitions \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","version":1,"bpmnXml":"<bpmn:definitions>...</bpmn:definitions>"}'
```

### Start instance

```bash
curl -X POST http://localhost:3000/v1/instances \
  -H "Content-Type: application/json" \
  -d '{"commandId":"cmd-1","definitionId":"<definitionId>"}'
```

### Submit decision (XOR gateway)

```bash
curl -X POST http://localhost:3000/v1/instances/<instanceId>/decisions/<decisionId> \
  -H "Content-Type: application/json" \
  -d '{"commandId":"cmd-2","outcome":{"selectedFlowIds":["<flowId>"]}}'
```

### Complete work item

```bash
curl -X POST http://localhost:3000/v1/instances/<instanceId>/work-items/<workItemId>/complete \
  -H "Content-Type: application/json" \
  -d '{"commandId":"cmd-2"}'
```

### Query instance

```bash
curl http://localhost:3000/v1/instances/<instanceId>
curl http://localhost:3000/v1/instances/<instanceId>/state
```

## Publishing

On every push to `main`, a GitHub Action:

1. Runs tests (`npm run test:sdk`)
2. Bumps the patch version (`0.1.0` → `0.1.1`)
3. Publishes to npm
4. Commits the version bump back to the repo (with `[skip ci]` to avoid loops)

**Setup**: Add `NPM_TOKEN` as a repository secret in GitHub. Create a token at [npmjs.com/access-tokens](https://www.npmjs.com/access-tokens) with "Automation" type (or "Publish" for granular access).

---

## Test

```bash
npm test              # all tests (unit + conformance)
npm run test:unit      # unit tests only (no MongoDB)
npm run test:conformance   # conformance tests (requires MongoDB, see readme/TEST.md)
npm run test:integration   # integration script (requires MongoDB)
```
