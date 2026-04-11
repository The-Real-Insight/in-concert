export const config = {
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017/in-concert',
  /** BPM engine data: definitions, instances, tasks, history, etc. */
  mongoBpmDb: process.env.MONGO_BPM_DB ?? process.env.MONGO_DB ?? 'in-concert',
  /** Conversations only (tri-model shared). NEVER purged. */
  mongoDb: process.env.MONGO_DB ?? 'in-concert',
  port: parseInt(process.env.PORT ?? '3000', 10),
  /** Expose The Real Insight model source in the portal. Set TRI_TESTING=true in .env. */
  triTesting: process.env.TRI_TESTING === 'true',
};
