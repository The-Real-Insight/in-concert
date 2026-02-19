import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import type { ProcessInstanceHistoryDoc } from '../db/collections';
import type { ProcessInstanceEventDoc } from '../db/collections';
import type { NormalizedGraph } from '../model/types';

type InstanceDoc = {
  startedBy?: string;
  startedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
};

type ContinuationPayload = {
  workItemId?: string;
  completedBy?: string;
  completedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
  result?: unknown;
};

/**
 * Build audit trail records from process events.
 * Called by the processor after applying a transition.
 */
export function buildHistoryRecords(
  instanceId: string,
  events: ProcessInstanceEventDoc[],
  instance: InstanceDoc | null,
  continuationPayload: ContinuationPayload | null,
  graph: NormalizedGraph
): Omit<ProcessInstanceHistoryDoc, '_id'>[] {
  const records: Omit<ProcessInstanceHistoryDoc, '_id'>[] = [];
  const now = new Date();

  for (const ev of events) {
    if (ev.type === 'INSTANCE_CREATED') {
      records.push({
        instanceId,
        seq: ev.seq,
        eventType: 'INSTANCE_STARTED',
        at: ev.at,
        startedBy: instance?.startedBy,
        startedByDetails: instance?.startedByDetails,
        createdAt: now,
      });
    } else if (ev.type === 'WORK_ITEM_CREATED') {
      const payload = ev.payload as { workItemId?: string; nodeId?: string; scopeId?: string };
      const nodeId = payload.nodeId ?? '';
      const node = graph.nodes[nodeId];
      const nodeType = node?.type === 'userTask' ? 'userTask' : 'serviceTask';
      records.push({
        instanceId,
        seq: ev.seq,
        eventType: 'TASK_STARTED',
        at: ev.at,
        nodeId: payload.nodeId,
        nodeName: node?.name,
        nodeType,
        workItemId: payload.workItemId,
        scopeId: payload.scopeId,
        createdAt: now,
      });
    } else if (ev.type === 'WORK_ITEM_COMPLETED') {
      const payload = ev.payload as { workItemId?: string; nodeId?: string };
      const nodeId = payload.nodeId ?? '';
      const node = graph.nodes[nodeId];
      const nodeType = node?.type === 'userTask' ? 'userTask' : 'serviceTask';
      records.push({
        instanceId,
        seq: ev.seq,
        eventType: 'TASK_COMPLETED',
        at: ev.at,
        nodeId: payload.nodeId,
        nodeName: node?.name,
        nodeType,
        workItemId: payload.workItemId,
        completedBy: continuationPayload?.completedBy,
        completedByDetails: continuationPayload?.completedByDetails,
        result: continuationPayload?.result,
        createdAt: now,
      });
    }
  }

  return records;
}

/** Retrieve audit trail for a process instance, ordered by seq. */
export async function getProcessHistory(
  db: Db,
  instanceId: string
): Promise<ProcessInstanceHistoryDoc[]> {
  const { ProcessInstanceHistory } = getCollections(db);
  return ProcessInstanceHistory.find({ instanceId })
    .sort({ seq: 1 })
    .toArray();
}
