# SDK overview

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

The **SDK** is the supported way to deploy definitions, start instances, complete work, submit gateway decisions, and (optionally) drive the **worklist** over HTTP.

Published package: **`@the-real-insight/tri-bpmn-engine`**.

## Entry points (`package.json` exports)

| Subpath | Use for |
|---------|---------|
| `@the-real-insight/tri-bpmn-engine` | Main module (server bootstrap) |
| `@the-real-insight/tri-bpmn-engine/sdk` | `BpmnEngineClient`, `TriSdk`, types |
| `@the-real-insight/tri-bpmn-engine/db` | `connectDb`, `ensureIndexes`, `closeDb` for local mode |
| `@the-real-insight/tri-bpmn-engine/local` | In-process stream handlers (e.g. worklist projection in scripts) |
| `@the-real-insight/tri-bpmn-engine/validator` | BPMN validation utilities |
| `@the-real-insight/tri-bpmn-engine/tri-schema` | TRI schema helpers |

## Two execution modes

### REST mode

Talk to a **running** engine server:

```typescript
import { BpmnEngineClient } from '@the-real-insight/tri-bpmn-engine/sdk';

const client = new BpmnEngineClient({
  mode: 'rest',
  baseUrl: 'http://localhost:3000',
});
```

Use **`subscribeToCallbacks()`** for push notifications: the client opens a WebSocket to `{baseUrl}/ws`.

### Local mode

Embed the engine against a **MongoDB `Db`** (tests, scripts, custom servers):

```typescript
import { BpmnEngineClient } from '@the-real-insight/tri-bpmn-engine/sdk';
import { connectDb, ensureIndexes } from '@the-real-insight/tri-bpmn-engine/db';

const db = await connectDb();
await ensureIndexes(db);

const client = new BpmnEngineClient({ mode: 'local', db });
```

Use **`processUntilComplete()`**, **`recover()`**, or **`subscribeToCallbacks()`** depending on your hosting model.

## `TriSdk`: engine + worklist HTTP facade

`TriSdk` combines **`BpmnEngineClient`** (engine) with thin **`fetch`** wrappers for **`/v1/tasks`** (claim, activate, complete, list):

```typescript
import { TriSdk } from '@the-real-insight/tri-bpmn-engine/sdk';

const sdk = new TriSdk({
  engine: { mode: 'rest', baseUrl: 'http://localhost:3000' },
  tasks: { baseUrl: 'http://localhost:3000' },
});

await sdk.engine.deploy(/* ... */);
await sdk.tasks.list({ status: 'OPEN' });
```

Use this when your app treats the engine as a remote service and human tasks flow through the worklist API.

## Full reference

Everything else—`init`, `deploy`, `startInstance`, callbacks, XOR decisions, worklist examples, and CLI patterns—is in the **[usage guide](usage.md)**.

## Source layout

Implementation lives under `src/sdk/`:

- `client.ts` — `BpmnEngineClient`  
- `facade.ts` — `TriSdk`  
- `types.ts` — shared callback and parameter types  
