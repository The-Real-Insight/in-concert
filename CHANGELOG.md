# Changelog

All notable changes to **in-concert** (`@the-real-insight/in-concert`) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are published to npm automatically on push to `main`.

---

## [Unreleased]

### Added
- **Unified `StartTrigger` plugin interface.** Timers and M365 mailbox connectors are now first-party plugins against this interface; hosts can register their own triggers (webhooks, S3, SQS, filesystems, etc.) without patching the engine. See [`docs/sdk/custom-triggers.md`](./docs/sdk/custom-triggers.md).
- **SharePoint folder trigger** (`tri:connectorType="sharepoint-folder"`). Watches a SharePoint document-library folder via the Graph `/delta` API and starts a process instance per new (or modified) matching file. Full `tri:*` attribute surface: `siteUrl`, `driveName`, `folderPath`, `recursive`, `includeModifications`, `fileNamePattern`, `minFileSizeBytes`, `itemType`, `pollIntervalSeconds`, `initialPolicy`. See [`src/triggers/sharepoint-folder/README.md`](./src/triggers/sharepoint-folder/README.md).
- **Idempotency key on `startInstance`.** A partial unique index on `ProcessInstance(definitionId, idempotencyKey)` makes repeat starts with the same key collapse to a single instance — the foundation for exactly-once trigger semantics. `startInstance` also gained an optional `session?: ClientSession` parameter and now wraps its writes in a transaction when none is passed, closing a latent crash-recovery hole.
- **Canonical REST endpoints** under `/v1/trigger-schedules/...` for managing schedules of any type. SDK adds `listTriggerSchedules`, `pauseTriggerSchedule`, `resumeTriggerSchedule`, `setTriggerCredentials`.
- **Unified `TriggerSchedule` Mongo collection** replacing the separate `TimerSchedule` and `ConnectorSchedule` collections. Migration script at `scripts/migrate-to-trigger-schedules.ts` (idempotent, dry-run supported, leaves source collections untouched).
- **CI decoupling guard.** A jest test at `test/decoupling/engine-isolation.test.ts` fails if any engine-core file outside the documented allowlist references specific trigger-type literals.

### Deprecated
- **`/v1/timer-schedules/*` and `/v1/connector-schedules/*` REST endpoints** are retained as filtered views over `/v1/trigger-schedules` but will be **removed in the next major release**. Their SDK wrappers (`listTimerSchedules`, `listConnectorSchedules`, `pauseTimerSchedule`, `resumeTimerSchedule`, `pauseConnectorSchedule`, `resumeConnectorSchedule`, `setConnectorCredentials`) are deprecated similarly.
- **`EngineInitConfig.connectors['graph-mailbox']`** is kept as an env-var pass-through. Prefer per-schedule credentials via `setTriggerCredentials()`. Removed in the next major release.

### Changed
- Graph mailbox polling and timer firing are now driven by a single generic scheduler (`src/workers/trigger-scheduler.ts`). The old dedicated `connectorLoop` and `timerLoop` in the server have been removed. Server now runs one `triggerLoop` instead.
- Instance creation from triggers commits atomically with cursor advance: `ProcessInstance` + `ProcessInstanceState` + `Continuations` + `TriggerSchedule.cursor` are written in one transaction. A crash mid-fire rolls everything back; the sweeper re-exposes the lease and the next tick re-fires from the same cursor (deduped via `idempotencyKey`).

### Removed
- `src/timers/worker.ts` and `src/connectors/` — replaced by the generic scheduler and per-plugin directories under `src/triggers/`.

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
