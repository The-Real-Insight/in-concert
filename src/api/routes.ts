import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { config } from '../config';
import { deployDefinition } from '../model/service';
import { startInstance, getInstance, purgeInstance } from '../instance/service';
import { getProcessHistory } from '../history/service';
import { getCollections, COLLECTION_NAMES, type TimerScheduleStatus, type ConnectorScheduleStatus } from '../db/collections';
import { claimContinuation, processContinuation } from '../workers/processor';

export const apiRouter = Router();

/** Purge BPM collections in MONGO_BPM_DB only. NEVER purges MONGO_DB (Conversations). */
apiRouter.post('/v1/purge', async (req: Request, res: Response) => {
  const db = getDb();
  if (db.databaseName !== config.mongoBpmDb) {
    console.error('[purge] SAFETY: Refusing to purge non-BPM database', { databaseName: db.databaseName, expected: config.mongoBpmDb });
    res.status(500).json({ error: 'Purge must only run against MONGO_BPM_DB, never MONGO_DB' });
    return;
  }
  const cols = [
    COLLECTION_NAMES.ProcessDefinition,
    COLLECTION_NAMES.ProcessInstance,
    COLLECTION_NAMES.ProcessInstanceState,
    COLLECTION_NAMES.ProcessInstanceEvent,
    COLLECTION_NAMES.ProcessInstanceHistory,
    COLLECTION_NAMES.Continuation,
    COLLECTION_NAMES.Outbox,
    COLLECTION_NAMES.HumanTask,
  ];
  const errors: string[] = [];
  try {
    for (const name of cols) {
      try {
        await db.collection(name).deleteMany({});
      } catch (colErr) {
        const m = colErr instanceof Error ? colErr.message : String(colErr);
        errors.push(`${name}: ${m}`);
      }
    }
    if (errors.length > 0) {
      res.status(500).json({ error: errors.join('; '), purged: cols });
      return;
    }
    res.json({ purged: cols });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[purge]', msg);
    res.status(500).json({ error: msg || 'Purge failed' });
  }
});

apiRouter.post('/v1/definitions', async (req: Request, res: Response) => {
  try {
    const { id, name, version, bpmnXml, overwrite, tenantId } = req.body;
    if (!id || !name || version == null || version === '' || !bpmnXml) {
      res.status(400).json({ error: 'id, name, version, and bpmnXml are required' });
      return;
    }
    const db = getDb();
    const result = await deployDefinition(db, {
      id,
      name,
      version: String(version),
      bpmnXml,
      overwrite: Boolean(overwrite),
      tenantId,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Deploy failed';
    res.status(400).json({ error: message });
  }
});

apiRouter.post('/v1/instances', async (req: Request, res: Response) => {
  try {
    const { commandId, definitionId, conversationId, businessKey, tenantId, user } = req.body;
    if (!commandId || !definitionId) {
      res.status(400).json({ error: 'commandId and definitionId are required' });
      return;
    }
    const db = getDb();
    const result = await startInstance(db, {
      commandId,
      definitionId,
      conversationId,
      businessKey,
      tenantId,
      user,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Start failed';
    res.status(400).json({ error: message });
  }
});

apiRouter.get('/v1/instances', async (req: Request, res: Response) => {
  try {
    const { status, limit } = req.query;
    const db = getDb();
    const { ProcessInstances } = getCollections(db);
    const filter: Record<string, unknown> = {};
    if (status && typeof status === 'string') filter.status = status;
    const limitNum = Math.min(parseInt(String(limit || '50'), 10) || 50, 200);
    const list = await ProcessInstances.find(filter)
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .toArray();
    res.json({ items: list });
  } catch (err) {
    res.status(500).json({ error: 'List failed' });
  }
});

apiRouter.get('/v1/instances/:instanceId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const doc = await getInstance(db, req.params.instanceId);
    if (!doc) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

/** Purge an instance and the transitive closure of its child instances. */
apiRouter.delete('/v1/instances/:instanceId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await purgeInstance(db, req.params.instanceId);
    if (!result) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Purge failed';
    res.status(500).json({ error: message });
  }
});

apiRouter.get('/v1/instances/:instanceId/bpmn', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const instance = await getInstance(db, req.params.instanceId);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const { ProcessDefinitions } = getCollections(db);
    const def = await ProcessDefinitions.findOne(
      { _id: instance.definitionId },
      { projection: { bpmnXml: 1 } }
    );
    if (!def?.bpmnXml) {
      res.status(404).json({ error: 'BPMN not found for this definition' });
      return;
    }
    res.setHeader('Content-Type', 'application/xml');
    res.send(def.bpmnXml);
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

apiRouter.get('/v1/instances/:instanceId/history', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const instance = await getInstance(db, req.params.instanceId);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const entries = await getProcessHistory(db, req.params.instanceId);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

apiRouter.get('/v1/instances/:instanceId/state', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { ProcessInstanceState } = getCollections(db);
    const doc = await ProcessInstanceState.findOne(
      { _id: req.params.instanceId },
      { projection: { tokens: 1, scopes: 1, waits: 1, status: 1, version: 1 } }
    );
    if (!doc) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

apiRouter.post(
  '/v1/instances/:instanceId/decisions/:decisionId',
  async (req: Request, res: Response) => {
    try {
      const { instanceId, decisionId } = req.params;
      const { commandId, idempotencyKey, outcome } = req.body;
      if (!commandId || !outcome?.selectedFlowIds) {
        res.status(400).json({ error: 'commandId and outcome.selectedFlowIds are required' });
        return;
      }
      const db = getDb();
      const cols = getCollections(db);
      const { ProcessInstanceState, Continuations } = cols;
      const state = await ProcessInstanceState.findOne({ _id: instanceId });
      if (!state) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      const decision = state.waits?.decisions?.find((d) => d.decisionId === decisionId);
      if (!decision) {
        res.status(404).json({ error: 'Decision not found or already applied' });
        return;
      }
      const { selectedFlowIds } = outcome;
      if (decision.kind === 'XOR_SPLIT' && selectedFlowIds.length !== 1) {
        res.status(400).json({ error: 'XOR_SPLIT requires exactly one selectedFlowId' });
        return;
      }
      const now = new Date();
      await Continuations.insertOne({
        _id: uuidv4(),
        instanceId,
        dueAt: now,
        kind: 'DECISION_RECORDED',
        payload: { decisionId, selectedFlowIds, commandId },
        status: 'READY',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      res.status(202).json({ accepted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Decision failed';
      res.status(400).json({ error: message });
    }
  }
);

apiRouter.post(
  '/v1/instances/:instanceId/multi-instance/resolve',
  async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { nodeId, tokenId, scopeId, items } = req.body;
      if (!nodeId || !tokenId || !scopeId || !Array.isArray(items)) {
        res.status(400).json({ error: 'nodeId, tokenId, scopeId, and items (array) are required' });
        return;
      }
      const db = getDb();
      const { Continuations } = getCollections(db);
      const now = new Date();
      await Continuations.insertOne({
        _id: uuidv4(),
        instanceId,
        dueAt: now,
        kind: 'MULTI_INSTANCE_RESOLVED',
        payload: { nodeId, tokenId, scopeId, items },
        status: 'READY',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      res.status(202).json({ accepted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Submit multi-instance data failed';
      res.status(400).json({ error: message });
    }
  }
);

apiRouter.post(
  '/v1/instances/:instanceId/work-items/:workItemId/complete',
  async (req: Request, res: Response) => {
    try {
      const { instanceId, workItemId } = req.params;
      const { commandId, result, completedBy, completedByDetails, user } = req.body;
      if (!commandId) {
        res.status(400).json({ error: 'commandId is required' });
        return;
      }
      const db = getDb();
      const cols = getCollections(db);
      const { Continuations } = cols;
      const now = new Date();
      const payload: Record<string, unknown> = { workItemId, commandId, result };
      if (user) {
        payload.completedBy = user.email;
        payload.completedByDetails = user;
      } else if (completedBy != null) {
        payload.completedBy = completedBy;
        if (completedByDetails != null) payload.completedByDetails = completedByDetails;
      }
      await Continuations.insertOne({
        _id: uuidv4(),
        instanceId,
        dueAt: now,
        kind: 'WORK_COMPLETED',
        payload,
        status: 'READY',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      res.status(202).json({ accepted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Complete failed';
      res.status(400).json({ error: message });
    }
  }
);

// ── Timer schedules ──────────────────────────────────────────────────────────

apiRouter.get('/v1/timer-schedules', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { TimerSchedules } = getCollections(db);
    const filter: Record<string, unknown> = {};
    if (req.query.definitionId) filter.definitionId = req.query.definitionId;
    if (req.query.status) filter.status = req.query.status;
    const items = await TimerSchedules.find(filter).sort({ nextFireAt: 1 }).toArray();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'List timer schedules failed' });
  }
});

apiRouter.get('/v1/timer-schedules/:scheduleId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { TimerSchedules } = getCollections(db);
    const doc = await TimerSchedules.findOne({ _id: req.params.scheduleId });
    if (!doc) {
      res.status(404).json({ error: 'Timer schedule not found' });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Get timer schedule failed' });
  }
});

apiRouter.post('/v1/timer-schedules/:scheduleId/pause', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { TimerSchedules } = getCollections(db);
    const result = await TimerSchedules.findOneAndUpdate(
      { _id: req.params.scheduleId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED' as TimerScheduleStatus, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      res.status(404).json({ error: 'Timer schedule not found or not ACTIVE' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Pause failed' });
  }
});

apiRouter.post('/v1/timer-schedules/:scheduleId/resume', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { TimerSchedules } = getCollections(db);
    const result = await TimerSchedules.findOneAndUpdate(
      { _id: req.params.scheduleId, status: 'PAUSED' },
      { $set: { status: 'ACTIVE' as TimerScheduleStatus, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      res.status(404).json({ error: 'Timer schedule not found or not PAUSED' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Resume failed' });
  }
});

// ── Connector schedules ──────────────────────────────────────────────────────

apiRouter.get('/v1/connector-schedules', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { ConnectorSchedules } = getCollections(db);
    const filter: Record<string, unknown> = {};
    if (req.query.definitionId) filter.definitionId = req.query.definitionId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.connectorType) filter.connectorType = req.query.connectorType;
    const items = await ConnectorSchedules.find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'List connector schedules failed' });
  }
});

apiRouter.get('/v1/connector-schedules/:scheduleId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { ConnectorSchedules } = getCollections(db);
    const doc = await ConnectorSchedules.findOne({ _id: req.params.scheduleId });
    if (!doc) {
      res.status(404).json({ error: 'Connector schedule not found' });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Get connector schedule failed' });
  }
});

apiRouter.post('/v1/connector-schedules/:scheduleId/pause', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { ConnectorSchedules } = getCollections(db);
    const result = await ConnectorSchedules.findOneAndUpdate(
      { _id: req.params.scheduleId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED' as ConnectorScheduleStatus, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      res.status(404).json({ error: 'Connector schedule not found or not ACTIVE' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Pause failed' });
  }
});

apiRouter.post('/v1/connector-schedules/:scheduleId/resume', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { ConnectorSchedules } = getCollections(db);
    const result = await ConnectorSchedules.findOneAndUpdate(
      { _id: req.params.scheduleId, status: 'PAUSED' },
      { $set: { status: 'ACTIVE' as ConnectorScheduleStatus, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      res.status(404).json({ error: 'Connector schedule not found or not PAUSED' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Resume failed' });
  }
});

apiRouter.put('/v1/connector-schedules/:scheduleId/credentials', async (req: Request, res: Response) => {
  try {
    const { tenantId, clientId, clientSecret } = req.body as {
      tenantId?: string; clientId?: string; clientSecret?: string;
    };
    if (!tenantId || !clientId || !clientSecret) {
      res.status(400).json({ error: 'tenantId, clientId, and clientSecret are required' });
      return;
    }
    const db = getDb();
    const { ConnectorSchedules } = getCollections(db);
    const result = await ConnectorSchedules.findOneAndUpdate(
      { _id: req.params.scheduleId },
      {
        $set: {
          'config.tenantId': tenantId,
          'config.clientId': clientId,
          'config.clientSecret': clientSecret,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
    if (!result) {
      res.status(404).json({ error: 'Connector schedule not found' });
      return;
    }
    res.json({ accepted: true });
  } catch (err) {
    res.status(500).json({ error: 'Set credentials failed' });
  }
});

// ── Bulk schedule management ─────────────────────────────────────────────────

apiRouter.post('/v1/definitions/:definitionId/schedules/activate', async (req: Request, res: Response) => {
  try {
    const { definitionId } = req.params;
    const { graphCredentials, startingTenantId } = req.body as {
      graphCredentials?: { tenantId: string; clientId: string; clientSecret: string };
      startingTenantId?: string;
    };
    const db = getDb();
    const { TimerSchedules, ConnectorSchedules } = getCollections(db);
    const now = new Date();

    const connectorSet: Record<string, unknown> = {
      status: 'ACTIVE' as ConnectorScheduleStatus,
      updatedAt: now,
    };
    if (graphCredentials) {
      connectorSet['config.tenantId'] = graphCredentials.tenantId;
      connectorSet['config.clientId'] = graphCredentials.clientId;
      connectorSet['config.clientSecret'] = graphCredentials.clientSecret;
    }
    if (typeof startingTenantId === 'string' && startingTenantId.length > 0) {
      connectorSet.startingTenantId = startingTenantId;
    }
    await ConnectorSchedules.updateMany({ definitionId }, { $set: connectorSet });

    const timerSet: Record<string, unknown> = { status: 'ACTIVE', updatedAt: now };
    if (typeof startingTenantId === 'string' && startingTenantId.length > 0) {
      timerSet.startingTenantId = startingTenantId;
    }
    await TimerSchedules.updateMany(
      { definitionId, status: { $ne: 'EXHAUSTED' } },
      { $set: timerSet },
    );

    res.json({ accepted: true });
  } catch (err) {
    res.status(500).json({ error: 'Activate schedules failed' });
  }
});

apiRouter.post('/v1/definitions/:definitionId/schedules/deactivate', async (req: Request, res: Response) => {
  try {
    const { definitionId } = req.params;
    const db = getDb();
    const { TimerSchedules, ConnectorSchedules } = getCollections(db);
    const now = new Date();

    await ConnectorSchedules.updateMany(
      { definitionId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED' as ConnectorScheduleStatus, updatedAt: now } },
    );
    await TimerSchedules.updateMany(
      { definitionId, status: 'ACTIVE' },
      { $set: { status: 'PAUSED', updatedAt: now } },
    );

    res.json({ accepted: true });
  } catch (err) {
    res.status(500).json({ error: 'Deactivate schedules failed' });
  }
});
