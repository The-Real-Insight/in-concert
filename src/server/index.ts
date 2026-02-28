/**
 * Demo server with browser UI: start processes, worklist, auto-mode, history.
 * Same interaction model as the CLI test tool.
 * Uses MONGO_URL and MONGO_DB from src/server/.env (loaded via -r load-env).
 */
import { createServer } from 'http';
import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { connectDb, closeDb, getDb, getConversationsDb } from '../db/client';
import { ensureIndexes } from '../db/indexes';
import { apiRouter } from '../api/routes';
import { worklistRouter } from '../worklist/routes';
import { createProjectionHandler } from '../worklist/projection';
import { addStreamHandler } from '../ws/broadcast';
import { config } from '../config';
import { claimContinuation, processContinuation } from '../workers/processor';
import { broadcastAll } from '../ws/broadcast';
import { attachWebSocketServer } from '../ws/server';
import { v4 as uuidv4 } from 'uuid';
import { getCollections } from '../db/collections';
import { serverRouter } from './routes';
import { getInstance } from '../instance/service';
import { addBotMessage } from './conversation';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(apiRouter);
app.use(worklistRouter);
app.use(serverRouter);

// Serve UI (works from src/server or dist/server if public copied)
const publicDir =
  existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : path.join(process.cwd(), 'src', 'server', 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Never return HTML for API paths; return JSON 404 so client gets a clear error
app.use((req, res) => {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/demo/')) {
    res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
  } else {
    res.status(404).send('Not found');
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const msg = err instanceof Error ? err.message : 'Internal error';
  res.status(500).json({ error: msg });
});

// Auto-complete service tasks (assess-*, calculate-results, etc.)
function createServiceTaskHandler() {
  const baseUrl = `http://localhost:${config.port}`;
  return async (payload: { callbacks?: Array<{ kind: string; instanceId: string; payload: Record<string, unknown> }> }) => {
    if (!payload.callbacks) return;
    const db = getDb();
    for (const cb of payload.callbacks) {
      if (cb.kind !== 'CALLBACK_WORK') continue;
      const p = cb.payload as { kind?: string; workItemId?: string; name?: string };
      if (p.kind !== 'serviceTask') continue;
      const workItemId = p.workItemId;
      if (!workItemId) continue;

      const name = p.name ?? '';
      try {
        const instance = await getInstance(db, cb.instanceId);
        if (instance?.conversationId && name) {
          await addBotMessage(getConversationsDb(), instance.conversationId, `[${name}]`);
        }
      } catch (err) {
        console.error('Add bot message failed:', err);
      }

      let result: unknown;
      if (name.startsWith('assess-')) {
        result = { assessed: true, input: 'mock' };
      } else {
        result = { value: `The result is ${Math.floor(Math.random() * 1000)}` };
      }

      try {
        await fetch(`${baseUrl}/v1/instances/${cb.instanceId}/work-items/${workItemId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commandId: uuidv4(),
            result,
          }),
        });
      } catch (err) {
        console.error('Service task complete failed:', err);
      }
    }
  };
}

const POLL_MS = 500;

async function workerLoop() {
  const db = getDb();
  while (true) {
    try {
      const continuation = await claimContinuation(db);
      if (continuation) {
        try {
          const { outbox, events } = await processContinuation(db, continuation);
          broadcastAll(outbox, events);
        } catch (err) {
          console.error('Continuation failed:', err);
          const { Continuations } = getCollections(db);
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

  addStreamHandler(createProjectionHandler(db));
  addStreamHandler(createServiceTaskHandler());

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`tri-bpmn-engine demo server: http://localhost:${config.port}`);
    console.log(`  UI: http://localhost:${config.port}/`);
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
