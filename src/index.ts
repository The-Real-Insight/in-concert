import { createServer } from 'http';
import express from 'express';
import { connectDb, closeDb, getDb } from './db/client';
import { ensureIndexes } from './db/indexes';
import { apiRouter } from './api/routes';
import { worklistRouter } from './worklist/routes';
import { createProjectionHandler } from './worklist/projection';
import { addStreamHandler } from './ws/broadcast';
import { config } from './config';
import { claimContinuation, processContinuation } from './workers/processor';
import { broadcastAll } from './ws/broadcast';
import { attachWebSocketServer } from './ws/server';
import { emitEngineAttributionNoticeOnce } from './attribution';
import { sweepExpiredLeases } from './workers/sweeper';
import { dispatchOutboxBatch, markOutboxSent } from './workers/outbox-dispatcher';

const app = express();
app.use(express.json());
app.use(apiRouter);
app.use(worklistRouter);

const POLL_MS = 500;
const SWEEPER_INTERVAL_MS = 10_000;
const OUTBOX_DISPATCH_INTERVAL_MS = 500;

async function workerLoop() {
  const db = getDb();
  while (true) {
    try {
      const continuation = await claimContinuation(db);
      if (continuation) {
        try {
          const { outbox, events } = await processContinuation(db, continuation);
          broadcastAll(outbox, events);
          if (outbox.length > 0) {
            await markOutboxSent(db, outbox.map((o) => o._id));
          }
        } catch (err) {
          console.error('Continuation failed:', err);
          const { Continuations } = (await import('./db/collections')).getCollections(db);
          await Continuations.updateOne(
            { _id: continuation._id },
            { $set: { status: 'READY', updatedAt: new Date() }, $unset: { ownerId: '', leaseUntil: '' } }
          );
        }
      }
    } catch (err) {
      console.error('Worker error:', err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function sweeperLoop() {
  const db = getDb();
  while (true) {
    try {
      await sweepExpiredLeases(db);
    } catch (err) {
      console.error('Sweeper error:', err);
    }
    await new Promise((r) => setTimeout(r, SWEEPER_INTERVAL_MS));
  }
}

async function outboxDispatcherLoop() {
  const db = getDb();
  while (true) {
    try {
      await dispatchOutboxBatch(db);
    } catch (err) {
      console.error('Outbox dispatcher error:', err);
    }
    await new Promise((r) => setTimeout(r, OUTBOX_DISPATCH_INTERVAL_MS));
  }
}

async function main() {
  emitEngineAttributionNoticeOnce();
  const db = await connectDb();
  await ensureIndexes(db);

  // Reclaim any leases that outlived the previous process, then resume.
  const swept = await sweepExpiredLeases(db);
  if (swept.continuations + swept.timers + swept.connectors + swept.triggers > 0) {
    console.log(`[Startup] Reclaimed expired leases:`, swept);
  }

  addStreamHandler(createProjectionHandler(db));

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`in-concert listening on port ${config.port} (HTTP + WS /ws)`);
    console.log(`  MONGO_URL:     ${config.mongoUrl}`);
    console.log(`  MONGO_BPM_DB:  ${config.mongoBpmDb}`);
  });

  workerLoop();
  sweeperLoop();
  outboxDispatcherLoop();

  process.on('SIGTERM', async () => {
    httpServer.close();
    await closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
