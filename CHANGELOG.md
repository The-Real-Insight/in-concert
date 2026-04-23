# Changelog

All notable changes to **in-concert** (`@the-real-insight/in-concert`) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are published to npm automatically on push to `main`.

---

## [Unreleased]

### Added
- **`onFileReceived` hook on the sharepoint-folder trigger.** Per-file host callback that runs between `ProcessInstance` creation and START continuation insertion — the exact same lifecycle position as `graph-mailbox`'s `onMailReceived`. The event carries full file metadata (`itemId`, `name`, `path`, `size`, `mimeType`, `eTag`, `webUrl`, timestamps) plus a lazy `getFileContent()` that downloads the bytes on demand via Graph. Hosts can return `{ skip: true }` to cancel an instance before BPMN starts (throws are treated as skip, so a buggy callback can't leave half-configured instances running). Register via constructor option `new SharePointFolderTrigger({ onFileReceived })` or at init time with `registry.get('sharepoint-folder').setOnFileReceived(fn)`. Internal structural change: `SharePointFolderTrigger.fire()` now creates each matching item's `ProcessInstance` inline (mirroring `graph-mailbox.fire()`) rather than returning `StartRequest[]` to the scheduler, so the callback has somewhere to land. See [`src/triggers/sharepoint-folder/README.md`](./src/triggers/sharepoint-folder/README.md).
- **`getDriveItemContent(driveId, itemId, credentials?)` helper** in `@the-real-insight/in-concert/triggers/sharepoint-folder`. The sharepoint-folder plugin uses it internally for `FileReceivedEvent.getFileContent()`; hosts can call it directly when they need the bytes outside the trigger's lifecycle.

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
