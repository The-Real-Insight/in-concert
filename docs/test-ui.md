# Browser demo (test UI)

The **demo server** is an Express app that serves a static **browser UI** and the same **`/v1`** REST API and **`/ws`** WebSocket endpoint as the main engine. It is intended for **manual exploration**, demos, and quick validation—not as a production admin console.

Source: `src/server/index.ts`, static assets in `src/server/public/`.

## Start the demo

Requires MongoDB (same `.env` / `MONGO_URL` pattern as the rest of the project). From the repository root:

```bash
npm run server
```

By default the npm script sets **`PORT=9100`**. Open:

**http://localhost:9100/**

If you set `PORT` yourself, use that port instead.

## What the UI does

### Header: test user and data hygiene

- **User** fields (email, first/last name) are sent with demo actions so instances and tasks resemble real identity-backed flows.  
- **Purge DB** clears BPM-related data used by the demo (definitions, instances, tasks, history). **Conversation data** in the shared database is not purged—see the button tooltip and server code for exact scope.

### Start process

- **Model source**  
  - **Local** — BPMN files shipped under `test/bpmn/` (see `LOCAL_MODELS` in `src/server/routes.ts`).  
  - **The Real Insight** — loads models from the `AgenticWorkflow` collection in MongoDB (integration with the broader TRI stack).  
- **Provider filter** — when using the Insight source, narrows available workflows.  
- **Upload** — drag-and-drop or browse additional BPMN (and related) files for ad-hoc runs.  
- **Start process** — deploys when needed, starts an instance, and wires **conversation** features when configured.

### Worklist

- Lists **human tasks** from the worklist projection (`OPEN`, etc.).  
- **Refresh** reloads tasks.  
- **Auto** mode automatically picks the next task, prompts for input, and completes—useful for long linear models.  
- **Roles panel** — shows lane / `tri:roleId` style roles extracted from the active model for testing role-based filtering.

### Active task

- After **claim** / **activate**, shows the selected task, optional **context documents**, file upload, and completion.

### Process history & diagram

- Select a completed (or running) instance to inspect **audit-style history**.  
- **Diagram** view (`diagram.html`) visualizes structure when available for the selected model.

### Service tasks in the demo

The demo server registers a **service-task handler** that auto-completes many built-in tool names (e.g. `assess-*`, `calculate-results`) so flows reach user tasks and gateways without an external integration. Inspect `src/server/index.ts` for the exact behavior.

## Authentication notes

Some demo routes inspect an **`Authorization`** header (JWT) to resolve the current user (`src/server/jwt.ts`). For local testing you can often rely on the synthetic user fields in the UI; see route handlers for when a real token is required.

## Related tools

- **Interactive CLI** — `npm run cli` (`test/cli/interactive.ts`): terminal-driven worklist loop, same conceptual model as the browser UI.  
- **Main API server** — `npm run dev`: engine without the demo-only routes and static site (default port **3000**).

## See also

- [SDK overview](sdk/README.md) and [usage guide](sdk/usage.md) for the APIs the UI calls.  
- [Getting started](getting-started.md) for environment variables and ports.  
