# Changelog

All notable changes to **in-concert** (`@the-real-insight/in-concert`) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are published to npm automatically on push to `main`.

---

## [Unreleased]

### Changed (breaking)
- **Singleton engine worker — `startEngineWorker()` required before `run()` in local mode.** Every entry point that advanced a process — `run()`, `recover()`, the trigger scheduler, the outbox dispatcher — used to own its own claim loop against `Continuations`. Two loops live at once could race for the same row, with one attempt rolling back via the version-conflict path. Under load the races manifested as duplicate callbacks, missed dispatches, and flaky tests that looked like engine bugs but were orchestration bugs. The singleton refactor collapses all claim-and-dispatch into one worker per client (`EngineWorker`), subscribed to a Mongo change stream for low-latency delivery and a fallback poll for delayed work / stream gaps. `run(instanceId)` now registers a waiter with the worker and awaits its quiescence signal — no claim loop there, no exclusion lists, no read-after-write games. Consequence for consumers:

  ```typescript
  // Before:
  engine.init(handlers);
  await engine.run(instanceId);

  // After:
  engine.init(handlers);
  engine.startEngineWorker();     // required — run() throws without it
  await engine.run(instanceId);
  // on graceful shutdown:
  await engine.stopEngineWorker();
  ```

  `run(instanceId, handlers, options)` keeps its pre-singleton signature for source compatibility but **both extra arguments are ignored** — the worker uses the `init()` handlers, and there's no `maxIterations` to cap (the worker runs until `stopEngineWorker()`). Passing `handlers` logs a console warning. Legacy `processUntilComplete` still works (owns its own inline claim loop, no worker required) and is kept for self-contained scripts; **do not mix it with the singleton worker on the same instance** — that reopens the race the worker was built to avoid. REST mode is unaffected; the in-concert server runs its own worker. See the "Standard startup pattern" in [`docs/sdk/usage.md`](./docs/sdk/usage.md#recoveroptions) for the full migration.
- **Per-tenant `TriggerSchedule` rows** ([issue #7](https://github.com/The-Real-Insight/in-concert/issues/7)). The unique index on `TriggerSchedule` moves from `(definitionId, startEventId)` to `(definitionId, startEventId, startingTenantId)`. A single workflow definition may now have one schedule row per start event **per tenant** — the owner tenant (the `tenantId` passed to `deploy`) gets its row at deploy time, and procurer tenants get their own cloned rows the first time they call `activateSchedules(definitionId, { startingTenantId })`. Cloned rows start from the owner's current config, overlay the call's `configOverrides`, and reset runtime state (`cursor: null`, `credentials: null`, `status: 'PAUSED'` unless the plugin sets `deployStatus`). Tenants run independently from then on: separate credentials, cursor, fire history, pause/resume state. **Redeploy is owner-scoped**: overwriting a definition rewrites the owner's row and prunes orphans *only under the owner's `startingTenantId`* — procurer rows are left alone, so a procurer's `configOverrides` survive every owner redeploy. **Deactivate is tenant-scoped**: `deactivateSchedules(definitionId, { startingTenantId })` pauses only the caller's row; omitting the option reverts to the legacy bulk behaviour and pauses every row for the definition. Legacy single-tenant deploys (no `tenantId` passed to `deploy`) continue to produce one row with `startingTenantId` unset, and legacy `activateSchedules(definitionId)` / `deactivateSchedules(definitionId)` calls still match that row by absence of the field. The old `definitionId_1_startEventId_1` index is dropped at `ensureIndexes` time; hosts that pinned against it must re-run startup to pick up the new shape. Migration is expected to be no-op for existing single-tenant installs; multi-tenant installs that already had the legacy index collide with per-tenant rows should drop and reseed before upgrading.

### Added
- **SDK boundary hygiene: three new methods so hosts don't need to reach into Mongo.**
  - **`client.getTriggerSchedule(scheduleId): Promise<TriggerScheduleDoc | null>`** — single-row lookup by public `scheduleId`. Tolerates legacy callers passing `_id` by falling back to that match. REST: existing `GET /v1/trigger-schedules/:scheduleId` (which previously only matched `_id`; now matches `scheduleId` first, `_id` as fallback).
  - **`client.listTriggerSchedules({ startingTenantId })`** — new optional filter. REST query string `startingTenantId=<id>`. Lets multi-tenant hosts scope their schedule list without filtering in-process (though client-side filtering still works as a fallback on the older SDK).
  - **`client.setInstanceMetadata(instanceId, { conversationId?, tenantId? })`** — write host-supplied metadata onto an existing `ProcessInstance` without the host reaching into the `ProcessInstance` collection directly. Returns `true` when the row was found and updated, `false` when the instance doesn't exist. Fields are merged, not replaced — omitting a field leaves the existing value intact. REST: `PATCH /v1/instances/:instanceId/metadata`.
  - Rationale: the `ProcessInstance` and `TriggerSchedule` document shapes are internal contracts and may evolve across releases; hosts that cement themselves against `collection.findOne({ _id })` / `.updateOne(...)` shapes break silently on refactors. These three methods cover the read/write surface tri-server was using directly; a similar pass for any other host-side direct reads is recommended.
- **`ActivateSchedulesOptions.configOverrides`.** Optional `Record<string, string>` on `activateSchedules(definitionId, options)`. Each `(key, value)` is written as dotted `config.<key>` via `$set` into every matching non-timer `TriggerSchedule` for the definition — so BPMN-authored defaults for attrs the caller didn't override stay intact and only the named keys are replaced. Empty strings and nullish values are skipped so a blank from a tenant-filled form doesn't wipe out the author's default. Typical host use: a workflow offer's per-procurement configuration (mailbox for graph-mailbox, siteUrl/driveName/folderPath for sharepoint-folder) forwarded here at activate time. Works in both local and REST modes; the matching `/v1/definitions/:id/schedules/activate` endpoint accepts the same option on the body. Step towards per-tenant trigger schedules (see [issue #7](https://github.com/The-Real-Insight/in-concert/issues/7)).
- **`TriggerFireEvent` telemetry for operator diagnostics.** Every trigger fire that produces instances (outcome `'ok'`) or fails (outcome `'error'`) now writes a row to a new `TriggerFireEvent` collection — one row per interesting fire, with `durationMs`, `itemsObserved`/`itemsFired`/`itemsSkipped` counts, per-reason drop counters, created instance ids, and a structured `error` (stage + message + optional `httpStatus`/`upstreamCode`/`rawSnippet`). "No-op" cycles (empty observation, everything filtered) deliberately do **not** write rows — the schedule's `lastFiredAt` heartbeat carries the liveness signal there, so the events collection stays sized to interesting activity. TTL on `firedAt` defaults to 14 days; override via `IN_CONCERT_FIRE_EVENTS_TTL_DAYS`. Writes happen outside the fire's Mongo transaction — telemetry can never destabilise the business path.
- **`FireReporter` on `TriggerInvocation.report`.** Optional reporter plugins call to describe what happened: `report.observed(n)`, `report.fired(instanceId)`, `report.dropped(reason, count?)`, `report.error({ stage, message, … })`. The scheduler constructs one per fire, and after the fire reads the accumulated state to build the `TriggerFireEvent`. Custom `StartTrigger` plugins that ignore the field still produce minimal events — outcome + duration + any thrown error — because the scheduler infers those itself. The bundled plugins (graph-mailbox, sharepoint-folder, ai-listener, timer via the StartRequest path) populate the reporter so per-item counts and drop reasons are rich out of the box.
- **`client.listFireEvents({ scheduleId, limit?, outcome?, since? })` SDK method** + **`GET /v1/trigger-schedules/:scheduleId/fires`** REST endpoint. Powers the portal's expand-a-schedule-row fire-history view. Returns the most recent events, newest first; filter by outcome or time window.
- **Extension attributes on `<bpmn:sequenceFlow>` flow through to `onDecision`.** Previously the parser silently dropped any non-`condition` extension attribute on sequence flows. A BPMN like `<bpmn:sequenceFlow acme:condition1="x" acme:weight="0.7">…</bpmn:sequenceFlow>` now surfaces `{ 'acme:condition1': 'x', 'acme:weight': '0.7' }` on `flow.selfAttrs`, and the `CALLBACK_DECISION` payload carries them per-transition as `transition.attrs`. Same reserved-namespace rules as elsewhere (`bpmn`, `bpmndi`, `dc`, `di`, `xsi`, `xml`, `xmlns` excluded; everything else flows through verbatim). This was always the intent of the plugin contract; the parser gap was plumbing debt.

### Deprecated
- **`tri:condition` and `tri:roleId` engine-interpreted attributes.** The engine's own attributes have moved to the `in-concert:` namespace (see Added). The legacy `tri:*` forms are still accepted — existing BPMN files parse unchanged — but new authoring should use `in-concert:condition` on sequence flows and `in-concert:roleId` on lanes/participants. Support for the legacy forms will be removed in a future major release; the migration is a find-and-replace.

### Added
- **Engine-owned `in-concert:` namespace for engine-interpreted attributes.** The two attributes the engine itself consumes — flow conditions (`in-concert:condition` on `<bpmn:sequenceFlow>`) and role assignment (`in-concert:roleId` on `<bpmn:lane>` and `<bpmn:participant>`) — now live under an engine-owned namespace instead of TRI's company namespace. Cleanly separates "engine vocabulary" (under `in-concert:`) from "plugin vocabulary" (author's choice, `tri:*` for bundled TRI plugins, `acme:*` etc. for custom ones). When both forms are present on the same element, the canonical `in-concert:` form wins — mirroring the `bpmn:conditionExpression` > extension-attr precedence used elsewhere.
- **Namespace-agnostic extension-attribute parsing.** The parser now captures **any** `<prefix>:<name>` attribute on `<bpmn:message>` and `<bpmn:startEvent>` (and nested event-definition) elements, not just `tri:*`. Reserved prefixes excluded: `bpmn`, `bpmndi`, `dc`, `di`, `xsi`, `xml`, `xmlns`. Plugins can now define their own authoring vocabulary (`acme:*`, `myco:*`, …) and the engine passes those attributes through to `claimFromBpmn` verbatim. TRI's bundled triggers continue to use `tri:*` as their own convention.
- **`stripPrefix(attrs, prefix, omit?)` helper** in `@the-real-insight/in-concert/triggers`. Generic counterpart to the existing `stripTriPrefix`; lets plugin authors drop any namespace prefix from an attribute bag. `stripTriPrefix` is now a thin convenience wrapper over `stripPrefix`.
- **`onFileReceived` hook on the sharepoint-folder trigger.** Per-file host callback that runs between `ProcessInstance` creation and START continuation insertion — the exact same lifecycle position as `graph-mailbox`'s `onMailReceived`. The event carries full file metadata (`itemId`, `name`, `path`, `size`, `mimeType`, `eTag`, `webUrl`, timestamps) plus a lazy `getFileContent()` that downloads the bytes on demand via Graph. Hosts can return `{ skip: true }` to cancel an instance before BPMN starts (throws are treated as skip, so a buggy callback can't leave half-configured instances running). Register via constructor option `new SharePointFolderTrigger({ onFileReceived })` or at init time with `registry.get('sharepoint-folder').setOnFileReceived(fn)`. Internal structural change: `SharePointFolderTrigger.fire()` now creates each matching item's `ProcessInstance` inline (mirroring `graph-mailbox.fire()`) rather than returning `StartRequest[]` to the scheduler, so the callback has somewhere to land. See [`src/triggers/sharepoint-folder/README.md`](./src/triggers/sharepoint-folder/README.md).
- **`getDriveItemContent(driveId, itemId, credentials?)` helper** in `@the-real-insight/in-concert/triggers/sharepoint-folder`. The sharepoint-folder plugin uses it internally for `FileReceivedEvent.getFileContent()`; hosts can call it directly when they need the bytes outside the trigger's lifecycle.
- **`TriggerInvocation.startingTenantId` propagated to inline-creating plugins.** Plugins that create `ProcessInstance` rows directly inside `fire()` (graph-mailbox, sharepoint-folder) now receive the schedule's `startingTenantId` on the invocation and pass it as `startInstance({ tenantId })`. Without this, instances from those plugins landed with `tenantId: undefined` and were invisible to host-side tenant-scoped queries — even though the schedule itself carried the tenant correctly. Plugins that return `StartRequest[]` to the scheduler (ai-listener, custom plugins following that pattern) were already covered by the generic `persistFireResult` path; this change closes the inline-path gap. Additive — existing plugin implementations that don't read `invocation.startingTenantId` continue working, but the ProcessInstance rows they create will still lack `tenantId`.
- **AI-listener `ToolCallerFn` / `EvaluatorFn` get an optional 4th `config` argument.** Both injected functions now receive the full trigger config (every `tri:*` attribute kept by `claimFromBpmn`, minus the `connectorType` discriminator) as their final parameter. Hosts routing through an in-process tool runtime can forward operator-authored `parameterOverwrites`, `offerType`, `offerId`, etc. to their invocation API without a second round-trip to the schedule document. Existing 0.2.x implementations that declared only three parameters keep working — JavaScript ignores the extra argument at the call site and TypeScript sees the parameter as optional.

## [0.2.0]

### Added
- **New package subpath exports for triggers.** Consumers can now import:
  - `@the-real-insight/in-concert/triggers` — interface, registry, built-in classes
  - `@the-real-insight/in-concert/triggers/timer`
  - `@the-real-insight/in-concert/triggers/graph-mailbox`
  - `@the-real-insight/in-concert/triggers/sharepoint-folder`
  - `@the-real-insight/in-concert/triggers/ai-listener`
- **Unified `StartTrigger` plugin interface.** Timers and M365 mailbox connectors are now first-party plugins against this interface; hosts can register their own triggers (webhooks, S3, SQS, filesystems, etc.) without patching the engine. See [`docs/sdk/custom-triggers.md`](./docs/sdk/custom-triggers.md).
- **SharePoint folder trigger** (`tri:connectorType="sharepoint-folder"`). Watches a SharePoint document-library folder via the Graph `/delta` API and starts a process instance per new (or modified) matching file. Full `tri:*` attribute surface: `siteUrl`, `driveName`, `folderPath`, `recursive`, `includeModifications`, `fileNamePattern`, `minFileSizeBytes`, `itemType`, `pollIntervalSeconds`, `initialPolicy`. See [`src/triggers/sharepoint-folder/README.md`](./src/triggers/sharepoint-folder/README.md).
- **AI-listener trigger** (`tri:connectorType="ai-listener"`). Polls an MCP-style tool endpoint, feeds the result to an LLM together with a BPMN-authored prompt, and fires when the LLM answers "yes". The business rule — *how to interpret the signal* — lives in the prompt, not in code. Dedup via an LLM-supplied `correlationId` or a hash of the tool output. Tests and SDK-direct hosts can inject `callTool` / `evaluate` callbacks to bypass HTTP entirely. See [`src/triggers/ai-listener/README.md`](./src/triggers/ai-listener/README.md).
- **Idempotency key on `startInstance`.** A partial unique index on `ProcessInstance(definitionId, idempotencyKey)` makes repeat starts with the same key collapse to a single instance — the foundation for exactly-once trigger semantics. `startInstance` also gained an optional `session?: ClientSession` parameter and now wraps its writes in a transaction when none is passed, closing a latent crash-recovery hole.
- **Canonical REST endpoints** under `/v1/trigger-schedules/...` for managing schedules of any type. SDK adds `listTriggerSchedules`, `pauseTriggerSchedule`, `resumeTriggerSchedule`, `setTriggerCredentials`.
- **Unified `TriggerSchedule` Mongo collection** replacing the separate `TimerSchedule` and `ConnectorSchedule` collections. Migration script at `scripts/migrate-to-trigger-schedules.ts` (idempotent, dry-run supported, leaves source collections untouched).
- **CI decoupling guard.** A jest test at `test/decoupling/engine-isolation.test.ts` fails if any engine-core file outside the documented allowlist references specific trigger-type literals.
- **`client.startTriggerScheduler()` SDK method** for local-mode hosts. Returns a stop function and runs the polling loop that drains due `TriggerSchedule` rows (the same loop the REST server runs internally). Options: `registry?`, `pollMs?` (default `1000`), `onError?`. Without this, embedding hosts had to reach into `dist/workers/trigger-scheduler` — which is not part of the `exports` map and therefore blocked by Node's package-boundary enforcement.
- **Transparent extension-attribute model.** The engine core no longer names any `tri:*` attribute or any trigger-type discriminator. The parser emits raw attribute bags (`node.selfAttrs`, `node.messageAttrs`) pulled verbatim from BPMN; each `StartTrigger` plugin implements `claimFromBpmn(event)` and decides whether it owns a given start event, returning its own opaque `config` bag. Deploy iterates start events × registered plugins — first non-null claim wins. Adding a new `tri:*` attribute or an entirely new trigger type now touches only the plugin (and the editor); the engine library never needs a release for a host-side vocabulary change. The four built-in plugins (timer, graph-mailbox, sharepoint-folder, ai-listener) are the first consumers of the new contract and ship alongside the engine only as convenience, not as special cases.

### Changed (breaking, 0.2.0)
- **`StartTrigger` interface adds `claimFromBpmn(event): { config } | null`.** Hosts that implement custom triggers must provide this; return `null` for "not mine." The method receives a `BpmnStartEventView` — raw `selfAttrs` / `messageAttrs` bags plus the BPMN `eventDefinitionKind` (`'timer' | 'message' | 'conditional' | 'signal' | 'other' | 'none'`) and `timerDefinition`.
- **`StartTrigger.deployStatus?: 'ACTIVE' | 'PAUSED'`.** Optional. When present (e.g. timer = `'ACTIVE'`), redeploying the BPMN re-asserts that status on every call. When omitted (the default for connectors), the initial status is `'PAUSED'` on first insert and preserved across redeploys — so a host that activated credentials doesn't get flipped back to paused by an overwrite deploy.
- **`extractEvents` return shape** is now `{ nodeId, triggerType, config }[]` — the old `{ type: 'timer' | 'connector', expression?, connectorType? }` form is gone. The new shape is driven by the same claim loop as deploy, so preview and deploy can never drift.
- **`NodeDef.connectorConfig` replaced** by `NodeDef.selfAttrs` + `NodeDef.messageAttrs`. Plugins that walked `graph.nodes` directly to inspect trigger config must switch to the raw attribute bags.

### Deprecated
- **`/v1/timer-schedules/*` and `/v1/connector-schedules/*` REST endpoints** are retained as filtered views over `/v1/trigger-schedules` but will be **removed in the next major release**. Their SDK wrappers (`listTimerSchedules`, `listConnectorSchedules`, `pauseTimerSchedule`, `resumeTimerSchedule`, `pauseConnectorSchedule`, `resumeConnectorSchedule`, `setConnectorCredentials`) are deprecated similarly.
- **`EngineInitConfig.connectors['graph-mailbox']`** is kept as an env-var pass-through. Prefer per-schedule credentials via `setTriggerCredentials()`. Removed in the next major release.

### Changed
- Graph mailbox polling and timer firing are now driven by a single generic scheduler (`src/workers/trigger-scheduler.ts`). The old dedicated `connectorLoop` and `timerLoop` in the server have been removed. Server now runs one `triggerLoop` instead.
- Instance creation from triggers commits atomically with cursor advance: `ProcessInstance` + `ProcessInstanceState` + `Continuations` + `TriggerSchedule.cursor` are written in one transaction. A crash mid-fire rolls everything back; the sweeper re-exposes the lease and the next tick re-fires from the same cursor (deduped via `idempotencyKey`).

### Removed
- `src/timers/worker.ts` and `src/connectors/` — replaced by the generic scheduler and per-plugin directories under `src/triggers/`.
- Package subpaths `./timers/worker` and `./connectors/worker` — the files they pointed at are gone. Anyone importing these internal worker modules directly should migrate to the SDK (`client.run()`, `client.recover()`) or to `@the-real-insight/in-concert/triggers`.

### Migration notes
- **Run the migration script before deploying this version** against a Mongo instance that holds existing timer or connector schedules: `npx ts-node -r dotenv/config scripts/migrate-to-trigger-schedules.ts`. It's idempotent; re-running is safe.
- If you consume `listTimerSchedules()` or `listConnectorSchedules()`, note the return type is now `TriggerScheduleDoc[]` (config and metadata are reshaped; see the collection definitions in `src/db/collections.ts`). Check your code against the documented fields.
- Replace `TimerScheduleDoc` / `ConnectorScheduleDoc` imports with `TriggerScheduleDoc`.
- If you passed `onMailReceived` via `client.init()`, nothing changes — the forwarding to the mailbox trigger is automatic.

---

## [0.1.20] — 2026-04-16

### Added
- **RRULE recurrence rules (RFC 5545)** for timer start events. Supports `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `COUNT`, and `UNTIL` — enabling calendar-style schedules that cron cannot express (e.g. "last Friday of every month", "every 2 weeks on Mon/Wed/Fri", "second Tuesday of November").
- Participant-level `tri:roleId` inheritance in BPMN parser. When a process has no lanes, nodes inherit the role from their participant pool — fixing worklist visibility for single-pool processes.

---

## [0.1.18] — 2026-04-11

### Added
- Remote-use documentation and SDK usage guide.
- Database schema documentation.

### Changed
- README expanded with footer, logo, and banner.

---

## [0.1.x] — 2026 (patch series)

### Added
- Multi-instance support (`submitMultiInstanceData`).
- Role concept integrated with runtime and worklist.
- `getWorklistForUser` / `listTasks` / `activateTask` worklist API.
- Conversation ID propagation through process instances.
- BPMN validator (`validateBpmn`) exposed via SDK and REST.
- `deploy` separated from `startInstance`; stable `definitionId` introduced.
- Subprocess support with audit trail.
- Parallel gateway execution with CLI serialization.
- Full callback-demo test suite.
- Attribution enforcement (`src/attribution.ts`).

### Fixed
- Duplicate key errors in concurrent token flows.
- Role patch edge cases on gateway transitions.
- Jest `testTimeout` flag corrected for CI.

---

## [0.1.0] — 2025

### Added
- Initial public release.
- BPMN 2.0 execution engine for Node.js (TypeScript).
- MongoDB persistence via native driver (no ODM).
- Express HTTP API and WebSocket push for callbacks.
- SDK (`BpmnEngineClient`) with `rest` and `local` modes.
- End-to-end example flow for agent orchestration.
- Unit, conformance, SDK, and worklist test suites.
- Modified MIT license with attribution requirements.
