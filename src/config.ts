export const config = {
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017/tri-bpmn-engine',
  /** BPM engine data: definitions, instances, tasks, history, etc. */
  mongoBpmDb: process.env.MONGO_BPM_DB ?? process.env.MONGO_DB ?? 'BPM',
  /** Conversations only (tri-model shared). NEVER purged. */
  mongoDb: process.env.MONGO_DB ?? 'BPM',
  port: parseInt(process.env.PORT ?? '3000', 10),
};
