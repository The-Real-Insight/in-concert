# Changelog

All notable changes to **in-concert** (`@the-real-insight/in-concert`) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are published to npm automatically on push to `main`.

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
