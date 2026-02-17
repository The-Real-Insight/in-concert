import { createServer } from 'http';
import express from 'express';
import { connectDb, closeDb, getDb } from './db/client';
import { ensureIndexes } from './db/indexes';
import { apiRouter } from './api/routes';
import { config } from './config';
import { claimContinuation, processContinuation } from './workers/processor';
import { broadcastOutbox } from './ws/broadcast';
import { attachWebSocketServer } from './ws/server';

const app = express();
app.use(express.json());
app.use(apiRouter);

const POLL_MS = 500;

async function workerLoop() {
  const db = getDb();
  while (true) {
    try {
      const continuation = await claimContinuation(db);
      if (continuation) {
        try {
          const outbox = await processContinuation(db, continuation);
          if (outbox.length > 0) {
            broadcastOutbox(outbox);
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

async function main() {
  const db = await connectDb();
  await ensureIndexes(db);

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`tri-bpmn-engine listening on port ${config.port} (HTTP + WS /ws)`);
  });

  workerLoop();

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
