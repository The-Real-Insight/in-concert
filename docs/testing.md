# Testing

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

Tests use **Jest**. Some suites need a running **MongoDB** instance and variables from `.env` (see [Getting started](getting-started.md)).

## Commands (from `package.json`)

| Command | Scope |
|---------|--------|
| `npm test` | Default Jest run (unit + broader suites per `jest.config.js`) |
| `npm run test:unit` | Tests under `src/` only (no MongoDB for typical cases) |
| `npm run test:conformance` | BPMN conformance scripts under `test/scripts/conformance` |
| `npm run test:sdk` | SDK-focused tests under `test/sdk` |
| `npm run test:worklist` | Worklist / role-filter scenarios |
| `npm run test:integration` | `scripts/test-integration.ts` |
| `npm run test:callback` | Callback demo scripts (verbose options available) |

Increase timeouts are already set on some scripts for slower CI or local MongoDB.

## BPMN fixtures

Executable models live in **`test/bpmn/`**. Conformance and SDK tests reference these files by name.

## Conformance matrix

A human-readable scenario table (IDs, models, stimuli, expectations) is maintained in **[readme/TEST.md](../readme/TEST.md)**. It may not list every Jest test one-to-one; use it as a map of **intended** engine behavior while implementing or extending coverage.

## Tips

- Run `npm run test:unit` before pushing for fast feedback.  
- Run `npm run test:sdk` and `npm run test:conformance` when changing execution, persistence, or callbacks.  
- If MongoDB connection errors appear, confirm `MONGO_URL` and that the server is reachable.  
