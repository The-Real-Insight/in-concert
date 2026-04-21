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
import { emitEngineAttributionNoticeOnce } from '../attribution';
import { processOneConnector } from '../connectors/worker';
import { sweepExpiredLeases } from '../workers/sweeper';
import { dispatchOutboxBatch, markOutboxSent } from '../workers/outbox-dispatcher';
import { processOneTrigger } from '../workers/trigger-scheduler';
import { getDefaultTriggerRegistry } from '../triggers';

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

// ── NEO Watch handler ─────────────────────────────────────────────────────────

const NEO_TOOL_IDS = new Set(['fetch-neo-data', 'file-alert', 'log-all-clear']);
const NEO_REVIEW_THRESHOLD_KM = 50_000_000;

interface NeoScanResult {
  date: string;
  closestObject: { id: string; name: string; missDistanceKm: number; isHazardous: boolean } | null;
  requiresReview: boolean;
}

const neoStore = new Map<string, NeoScanResult>();
const neoInstances = new Set<string>();

async function fetchNeoData(date: string): Promise<NeoScanResult> {
  const url = `https://api.nasa.gov/neo/rest/v1/feed?start_date=${date}&end_date=${date}&api_key=DEMO_KEY`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NASA API ${res.status}`);
  const data = await res.json() as Record<string, any>;
  const objects: any[] = data.near_earth_objects?.[date] ?? [];
  const closest = objects
    .map(o => ({
      id: String(o.id),
      name: String(o.name),
      missDistanceKm: Math.round(parseFloat(o.close_approach_data?.[0]?.miss_distance?.kilometers ?? '0')),
      isHazardous: Boolean(o.is_potentially_hazardous_asteroid),
    }))
    .sort((a, b) => a.missDistanceKm - b.missDistanceKm)[0] ?? null;
  return { date, closestObject: closest, requiresReview: closest !== null && closest.missDistanceKm < NEO_REVIEW_THRESHOLD_KM };
}

function createNeoWatchHandler() {
  const baseUrl = `http://localhost:${config.port}`;
  type Cb = { kind: string; instanceId: string; payload: Record<string, unknown> };

  return async (payload: { callbacks?: Cb[] }) => {
    if (!payload.callbacks) return;
    for (const cb of payload.callbacks) {

      // ── Service tasks ──
      if (cb.kind === 'CALLBACK_WORK') {
        const p = cb.payload as { kind?: string; workItemId?: string; extensions?: Record<string, string> };
        if (p.kind !== 'serviceTask' || !p.workItemId) continue;
        const toolId = p.extensions?.['tri:toolId'];
        if (!toolId || !NEO_TOOL_IDS.has(toolId)) continue;

        neoInstances.add(cb.instanceId);
        let result: unknown = {};

        try {
          if (toolId === 'fetch-neo-data') {
            const date = new Date().toISOString().slice(0, 10);
            const scan = await fetchNeoData(date);
            neoStore.set(cb.instanceId, scan);
            result = { date: scan.date, closestObject: scan.closestObject, requiresReview: scan.requiresReview };
            console.log(`[NEO] ${cb.instanceId} — closest: ${scan.closestObject?.name} at ${scan.closestObject?.missDistanceKm.toLocaleString()} km — review: ${scan.requiresReview}`);
          } else if (toolId === 'file-alert') {
            const ctx = neoStore.get(cb.instanceId);
            console.log(`[NEO] CLOSE APPROACH ALERT filed for ${cb.instanceId}:`, ctx?.closestObject);
          } else if (toolId === 'log-all-clear') {
            const ctx = neoStore.get(cb.instanceId);
            console.log(`[NEO] All clear for ${cb.instanceId} on ${ctx?.date}. Closest: ${ctx?.closestObject?.name} at ${ctx?.closestObject?.missDistanceKm.toLocaleString()} km`);
          }
        } catch (err) {
          console.error(`[NEO] handler error (${toolId}):`, err);
        }

        try {
          await fetch(`${baseUrl}/v1/instances/${cb.instanceId}/work-items/${p.workItemId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commandId: uuidv4(), result }),
          });
        } catch (err) {
          console.error('[NEO] complete task failed:', err);
        }
      }

      // ── XOR gateway decision ──
      if (cb.kind === 'CALLBACK_DECISION') {
        if (!neoInstances.has(cb.instanceId)) continue;
        const p = cb.payload as { decisionId?: string; transitions?: Array<{ flowId: string; isDefault: boolean }> };
        if (!p.decisionId || !p.transitions?.length) continue;

        const ctx = neoStore.get(cb.instanceId);
        const requiresReview = ctx?.requiresReview ?? false;
        const selected = p.transitions.find(t => requiresReview ? !t.isDefault : t.isDefault) ?? p.transitions[0]!;

        console.log(`[NEO] Gateway decision for ${cb.instanceId}: ${requiresReview ? 'review required' : 'all clear'}`);
        try {
          await fetch(`${baseUrl}/v1/instances/${cb.instanceId}/decisions/${p.decisionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commandId: uuidv4(), outcome: { selectedFlowIds: [selected.flowId] } }),
          });
        } catch (err) {
          console.error('[NEO] submit decision failed:', err);
        }
      }
    }
  };
}

// ── Generic service task auto-completer (all models except NEO Watch) ─────────

function createServiceTaskHandler() {
  const baseUrl = `http://localhost:${config.port}`;
  return async (payload: { callbacks?: Array<{ kind: string; instanceId: string; payload: Record<string, unknown> }> }) => {
    if (!payload.callbacks) return;
    const db = getDb();
    for (const cb of payload.callbacks) {
      if (cb.kind !== 'CALLBACK_WORK') continue;
      const p = cb.payload as { kind?: string; workItemId?: string; name?: string; extensions?: Record<string, string> };
      if (p.kind !== 'serviceTask') continue;
      const workItemId = p.workItemId;
      if (!workItemId) continue;

      // NEO Watch tasks are handled by createNeoWatchHandler — skip here
      const toolId = p.extensions?.['tri:toolId'];
      if (toolId && NEO_TOOL_IDS.has(toolId)) continue;

      const name = p.name ?? '';
      try {
        const instance = await getInstance(db, cb.instanceId);
        if (instance?.conversationId) {
          const werkzeugName = name || 'Unbekannt';
          await addBotMessage(getConversationsDb(), instance.conversationId, `Ich habe das Werkzeug "${werkzeugName}" ausgeführt.`);
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
          body: JSON.stringify({ commandId: uuidv4(), result }),
        });
      } catch (err) {
        console.error('Service task complete failed:', err);
      }
    }
  };
}

const POLL_MS = 500;
const TRIGGER_POLL_MS = 1_000;
const CONNECTOR_POLL_MS = 2_000;
const SWEEPER_INTERVAL_MS = 10_000;
const OUTBOX_DISPATCH_INTERVAL_MS = 500;

async function connectorLoop() {
  const db = getDb();
  while (true) {
    try {
      await processOneConnector(db);
    } catch (err) {
      console.error('Connector worker error:', err);
    }
    await new Promise((r) => setTimeout(r, CONNECTOR_POLL_MS));
  }
}

async function triggerLoop() {
  const db = getDb();
  const registry = getDefaultTriggerRegistry();
  while (true) {
    try {
      const fired = await processOneTrigger(db, registry);
      if (fired) continue; // check immediately for another due trigger
    } catch (err) {
      console.error('Trigger worker error:', err);
    }
    await new Promise((r) => setTimeout(r, TRIGGER_POLL_MS));
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
  emitEngineAttributionNoticeOnce();
  const db = await connectDb();
  await ensureIndexes(db);

  const swept = await sweepExpiredLeases(db);
  if (swept.continuations + swept.timers + swept.connectors + swept.triggers > 0) {
    console.log(`[Startup] Reclaimed expired leases:`, swept);
  }

  addStreamHandler(createProjectionHandler(db));
  addStreamHandler(createNeoWatchHandler());
  addStreamHandler(createServiceTaskHandler());

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`in-concert portal: http://localhost:${config.port}`);
    console.log(`  MONGO_URL:    ${config.mongoUrl}`);
    console.log(`  MONGO_BPM_DB: ${config.mongoBpmDb}`);
  });

  workerLoop();
  triggerLoop();
  connectorLoop();
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
