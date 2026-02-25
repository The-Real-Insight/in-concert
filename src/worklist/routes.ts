/**
 * Worklist REST API: /v1/tasks
 */
import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { getCollections } from '../db/collections';

export const worklistRouter = Router();

worklistRouter.get('/v1/tasks', async (req: Request, res: Response) => {
  try {
    const { assigneeUserId, candidateRole, status, instanceId, limit, cursor, sortOrder } = req.query;
    const db = getDb();
    const { HumanTasks } = getCollections(db);

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    else filter.status = 'OPEN';
    if (assigneeUserId) filter.assigneeUserId = assigneeUserId;
    if (candidateRole) filter.candidateRoles = candidateRole;
    if (instanceId) filter.instanceId = instanceId;

    const limitNum = Math.min(parseInt(String(limit || '50'), 10) || 50, 100);
    const sortAsc = sortOrder === 'asc';
    const opts: { limit: number; skip?: number; sort?: Record<string, 1 | -1> } = {
      limit: limitNum,
      sort: { createdAt: sortAsc ? 1 : -1 },
    };
    if (cursor) opts.skip = parseInt(String(cursor), 10) || 0;

    const items = await HumanTasks.find(filter, opts).toArray();
    const nextCursor =
      items.length === limitNum ? String((opts.skip ?? 0) + items.length) : undefined;

    res.json({ items, nextCursor });
  } catch (err) {
    res.status(500).json({ error: 'List failed' });
  }
});

worklistRouter.get('/v1/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { HumanTasks } = getCollections(db);
    const doc = await HumanTasks.findOne({ _id: req.params.taskId });
    if (!doc) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Get failed' });
  }
});

/** Transition OPEN → CLAIMED with assignee; blocks other users. Used by both claim and activate. */
async function activateTask(
  db: ReturnType<typeof getDb>,
  taskId: string,
  userId: string
): Promise<import('../db/collections').HumanTaskDoc | null> {
  const { HumanTasks } = getCollections(db);
  const now = new Date();
  return HumanTasks.findOneAndUpdate(
    { _id: taskId, status: 'OPEN' },
    {
      $set: { status: 'CLAIMED', assigneeUserId: userId, claimedAt: now },
      $inc: { version: 1 },
    },
    { returnDocument: 'after' }
  );
}

worklistRouter.post('/v1/tasks/:taskId/activate', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { commandId, userId } = req.body;
    if (!commandId || !userId) {
      res.status(400).json({ error: 'commandId and userId are required' });
      return;
    }
    const db = getDb();
    const result = await activateTask(db, taskId, userId);
    if (!result) {
      const { HumanTasks } = getCollections(db);
      const existing = await HumanTasks.findOne({ _id: taskId });
      if (!existing) {
        res.status(404).json({ error: 'Task not found' });
      } else {
        res.status(409).json({ error: 'Task already activated by another user or not OPEN' });
      }
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Activate failed' });
  }
});

worklistRouter.post('/v1/tasks/:taskId/claim', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { commandId, userId } = req.body;
    if (!commandId || !userId) {
      res.status(400).json({ error: 'commandId and userId are required' });
      return;
    }
    const db = getDb();
    const result = await activateTask(db, taskId, userId);
    if (!result) {
      const { HumanTasks } = getCollections(db);
      const existing = await HumanTasks.findOne({ _id: taskId });
      if (!existing) {
        res.status(404).json({ error: 'Task not found' });
      } else {
        res.status(409).json({ error: 'Task already claimed or not OPEN' });
      }
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Claim failed' });
  }
});

worklistRouter.post('/v1/tasks/:taskId/unclaim', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { commandId, userId } = req.body;
    if (!commandId || !userId) {
      res.status(400).json({ error: 'commandId and userId are required' });
      return;
    }
    const db = getDb();
    const { HumanTasks } = getCollections(db);
    const now = new Date();
    const result = await HumanTasks.findOneAndUpdate(
      { _id: taskId, status: 'CLAIMED', assigneeUserId: userId },
      {
        $set: { status: 'OPEN' },
        $unset: { assigneeUserId: '', claimedAt: '' },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' }
    );
    if (!result) {
      const existing = await HumanTasks.findOne({ _id: taskId });
      if (!existing) {
        res.status(404).json({ error: 'Task not found' });
      } else {
        res.status(409).json({ error: 'Task not claimed by user or not CLAIMED' });
      }
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Unclaim failed' });
  }
});

worklistRouter.post('/v1/tasks/:taskId/complete', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { commandId, userId, result: taskResult } = req.body;
    if (!commandId || !userId) {
      res.status(400).json({ error: 'commandId and userId are required' });
      return;
    }
    const db = getDb();
    const cols = getCollections(db);
    const { HumanTasks, Continuations } = cols;

    const task = await HumanTasks.findOne({ _id: taskId });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (task.status !== 'OPEN' && task.status !== 'CLAIMED') {
      res.status(409).json({ error: 'Task already completed or canceled' });
      return;
    }
    if (task.status === 'CLAIMED' && task.assigneeUserId !== userId) {
      res.status(403).json({ error: 'Task claimed by another user' });
      return;
    }

    const now = new Date();
    await Continuations.insertOne({
      _id: uuidv4(),
      instanceId: task.instanceId,
      dueAt: now,
      kind: 'WORK_COMPLETED',
      payload: { workItemId: taskId, commandId, result: taskResult },
      status: 'READY',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Projection will mark COMPLETED when engine emits WORK_ITEM_COMPLETED
    res.status(202).json({ accepted: true });
  } catch (err) {
    res.status(500).json({ error: 'Complete failed' });
  }
});
