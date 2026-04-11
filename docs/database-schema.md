# Database schema (MongoDB)

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

This page is the **documentation entry point** for engine persistence. The **full specification**—every collection, field, type, semantics, nested structures, indexes, and event types—is maintained as a single canonical document in the repository:

**→ [MongoDB database schema (canonical)](../readme/database-schema.md)**

That file uses **Field | Type | Semantics** tables throughout and stays aligned with:

- [`src/db/collections.ts`](../src/db/collections.ts) — TypeScript types and collection names  
- [`src/db/indexes.ts`](../src/db/indexes.ts) — `ensureIndexes()` definitions  

## Quick orientation

- **BPM database:** `MONGO_BPM_DB` or `MONGO_DB` (default `BPM`) — holds all engine collections.  
- **Connection:** `MONGO_URL` — see [Getting started](getting-started.md).  
- **Startup:** call `ensureIndexes(db)` on the BPM `Db` after connecting (see [`src/db/index.ts`](../src/db/index.ts)).  

## Related documentation

- [Getting started](getting-started.md) — environment and running MongoDB.  
- [SDK usage — local mode](sdk/usage.md) — `connectDb`, `ensureIndexes`, embedding the engine.  
- [Requirements](../readme/REQUIREMENTS.md) — product-level persistence expectations.  
