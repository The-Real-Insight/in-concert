import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { deployDefinition } from '../model/service';
import { startInstance, getInstance } from '../instance/service';
import { getProcessHistory } from '../history/service';
import { getCollections } from '../db/collections';
import { claimContinuation, processContinuation } from '../workers/processor';

export const apiRouter = Router();

apiRouter.post('/v1/definitions', async (req: Request, res: Response) => {
  try {
    const { name, version, bpmnXml, tenantId } = req.body;
    if (!name || version === undefined || !bpmnXml) {
      res.status(400).json({ error: 'name, version, and bpmnXml are required' });
      return;
    }
    const db = getDb();
    const result = await deployDefinition(db, {
      name,
      version: Number(version),
      bpmnXml,
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
    const { commandId, definitionId, businessKey, tenantId, user } = req.body;
    if (!commandId || !definitionId) {
      res.status(400).json({ error: 'commandId and definitionId are required' });
      return;
    }
    const db = getDb();
    const result = await startInstance(db, {
      commandId,
      definitionId,
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
