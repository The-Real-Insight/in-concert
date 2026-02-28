/**
 * Database utilities for local-mode SDK usage.
 *
 * import { connectDb, ensureIndexes } from 'tri-bpmn-engine/db';
 * const db = await connectDb();
 * await ensureIndexes(db);
 * const client = new BpmnEngineClient({ mode: 'local', db });
 */
export { connectDb, closeDb, getDb, getConversationsDb } from './client';
export { ensureIndexes } from './indexes';
export { COLLECTION_NAMES, getCollections } from './collections';
