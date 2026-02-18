/**
 * Worklist projection: projects engine callbacks and lifecycle events to human_tasks.
 */
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import type { StreamPayload } from '../ws/broadcast';

export function createProjectionHandler(db: Db) {
  const { HumanTasks } = getCollections(db);

  return async (payload: StreamPayload): Promise<void> => {
    const now = new Date();

    if (payload.callbacks) {
      for (const cb of payload.callbacks) {
        if (cb.kind !== 'CALLBACK_WORK') continue;
        const p = cb.payload as { workItemId?: string; kind?: string; name?: string; lane?: string };
        if (p.kind !== 'userTask') continue;
        const workItemId = p.workItemId;
        if (!workItemId) continue;

        await HumanTasks.updateOne(
          { _id: workItemId },
          {
            $set: {
              _id: workItemId,
              instanceId: cb.instanceId,
              nodeId: (p as { nodeId?: string }).nodeId ?? '',
              name: p.name ?? 'Task',
              role: p.lane,
              status: 'OPEN',
              candidateRoles: p.lane ? [p.lane] : [],
              createdAt: now,
              version: 1,
            },
          },
          { upsert: true }
        );
      }
    }

    if (payload.lifecycle) {
      for (const ev of payload.lifecycle) {
        if (ev.type === 'WORK_ITEM_COMPLETED') {
          const p = ev.payload as { workItemId?: string; completedBy?: string; completedByDetails?: unknown };
          const workItemId = p.workItemId;
          if (workItemId) {
            const update: Record<string, unknown> = { status: 'COMPLETED', completedAt: now };
            if (p.completedBy != null) update.completedBy = p.completedBy;
            if (p.completedByDetails != null) update.completedByDetails = p.completedByDetails;
            await HumanTasks.updateOne(
              { _id: workItemId },
              { $set: update, $inc: { version: 1 } }
            );
          }
        }
        if (ev.type === 'WORK_ITEM_CANCELED') {
          const workItemId = (ev.payload as { workItemId?: string }).workItemId;
          if (workItemId) {
            await HumanTasks.updateOne(
              { _id: workItemId },
              { $set: { status: 'CANCELED', canceledAt: now }, $inc: { version: 1 } }
            );
          }
        }
        if (ev.type === 'INSTANCE_TERMINATED' || ev.type === 'INSTANCE_COMPLETED') {
          const instanceId = (ev.payload as { instanceId?: string }).instanceId;
          if (instanceId) {
            await HumanTasks.updateMany(
              { instanceId, status: { $in: ['OPEN', 'CLAIMED'] } },
              { $set: { status: 'CANCELED', canceledAt: now }, $inc: { version: 1 } }
            );
          }
        }
      }
    }
  };
}
