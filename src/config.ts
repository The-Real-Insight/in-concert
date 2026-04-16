export const config = {
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017/in-concert',
  /** BPM engine data: definitions, instances, tasks, history, etc. */
  mongoBpmDb: process.env.MONGO_BPM_DB ?? process.env.MONGO_DB ?? 'in-concert',
  /** Conversations only (tri-model shared). NEVER purged. */
  mongoDb: process.env.MONGO_DB ?? 'in-concert',
  port: parseInt(process.env.PORT ?? '3000', 10),
  /** Expose The Real Insight model source in the portal. Set TRI_TESTING=true in .env. */
  triTesting: process.env.TRI_TESTING === 'true',

  /** Microsoft Graph connector settings. Required for graph-mailbox polling. */
  graph: {
    tenantId: process.env.GRAPH_TENANT_ID ?? '',
    clientId: process.env.GRAPH_CLIENT_ID ?? '',
    clientSecret: process.env.GRAPH_CLIENT_SECRET ?? '',
    /** Default polling interval for graph-mailbox connectors (ms). */
    pollingIntervalMs: parseInt(process.env.GRAPH_POLLING_INTERVAL_MS ?? '10000', 10),
    /** Only fetch emails received within this many minutes. Default 1440 (24h). */
    sinceMinutes: parseInt(process.env.GRAPH_SINCE_MINUTES ?? '1440', 10),
  },
};
