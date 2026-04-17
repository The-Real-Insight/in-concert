import { v4 as uuidv4 } from 'uuid';
import { parseBpmnXml } from './parser';
import type { NormalizedGraph } from './types';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import { classifyTimer, computeNextFire, parseRepeat } from '../timers/expressions';
import { config } from '../config';

export type DeployResult = {
  definitionId: string;
};

export type DeployParams = {
  id: string;
  name: string;
  version: string;
  bpmnXml: string;
  overwrite?: boolean;
  tenantId?: string;
};

async function syncTimerSchedules(db: Db, definitionId: string, graph: NormalizedGraph): Promise<void> {
  const { TimerSchedules } = getCollections(db);
  const now = new Date();

  // Find all timer start events in the graph
  const timerStartNodes = graph.startNodeIds
    .map(id => graph.nodes[id])
    .filter(n => n?.type === 'startEvent' && n.timerDefinition);

  // Remove schedules for start events that no longer have timers
  const activeNodeIds = timerStartNodes.map(n => n.id);
  await TimerSchedules.deleteMany({
    definitionId,
    ...(activeNodeIds.length > 0
      ? { nodeId: { $nin: activeNodeIds } }
      : {}),
  });

  // Upsert a schedule for each timer start event
  for (const node of timerStartNodes) {
    const expr = classifyTimer(node.timerDefinition!);
    const nextFireAt = computeNextFire(expr, now);
    let remainingReps: number | null = null;
    if (expr.kind === 'cycle') {
      const rep = parseRepeat(expr.raw);
      remainingReps = rep.repetitions;
    }

    await TimerSchedules.updateOne(
      { definitionId, nodeId: node.id },
      {
        $set: {
          kind: expr.kind,
          expression: expr.raw,
          nextFireAt,
          remainingReps,
          status: 'ACTIVE',
          updatedAt: now,
        },
        $setOnInsert: {
          _id: uuidv4(),
          definitionId,
          nodeId: node.id,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
}

async function syncConnectorSchedules(db: Db, definitionId: string, graph: NormalizedGraph): Promise<void> {
  const { ConnectorSchedules } = getCollections(db);
  const now = new Date();

  const connectorStartNodes = graph.startNodeIds
    .map(id => graph.nodes[id])
    .filter(n => n?.type === 'startEvent' && n.connectorConfig?.connectorType);

  const activeNodeIds = connectorStartNodes.map(n => n.id);
  await ConnectorSchedules.deleteMany({
    definitionId,
    ...(activeNodeIds.length > 0
      ? { nodeId: { $nin: activeNodeIds } }
      : {}),
  });

  for (const node of connectorStartNodes) {
    const cc = node.connectorConfig!;
    const { connectorType, ...restConfig } = cc;
    const pollingIntervalMs =
      connectorType === 'graph-mailbox' ? config.graph.pollingIntervalMs : 10_000;

    await ConnectorSchedules.updateOne(
      { definitionId, nodeId: node.id },
      {
        $set: {
          connectorType,
          config: restConfig,
          pollingIntervalMs,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: uuidv4(),
          definitionId,
          nodeId: node.id,
          status: 'PAUSED',
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
}

export async function deployDefinition(
  db: Db,
  params: DeployParams
): Promise<DeployResult> {
  const { ProcessDefinitions } = getCollections(db);

  const graph = await parseBpmnXml(params.bpmnXml);

  if (graph.startNodeIds.length === 0) {
    throw new Error('Process must have at least one start event');
  }

  const now = new Date();
  const existing = await ProcessDefinitions.findOne(
    { id: params.id, version: params.version },
    { projection: { _id: 1 } }
  );

  if (existing) {
    if (params.overwrite !== true) {
      throw new Error(
        `Process definition already exists for id="${params.id}" version="${params.version}". Set overwrite=true to replace.`
      );
    }
    await ProcessDefinitions.updateOne(
      { _id: existing._id },
      {
        $set: {
          name: params.name,
          bpmnXml: params.bpmnXml,
          graph,
          deployedAt: now,
        },
      }
    );
    await syncTimerSchedules(db, existing._id, graph);
    await syncConnectorSchedules(db, existing._id, graph);
    return { definitionId: existing._id };
  }

  const definitionId = uuidv4();
  await ProcessDefinitions.insertOne({
    _id: definitionId,
    id: params.id,
    tenantId: params.tenantId,
    name: params.name,
    version: params.version,
    bpmnXml: params.bpmnXml,
    graph,
    createdAt: now,
    deployedAt: now,
  });

  await syncTimerSchedules(db, definitionId, graph);
  await syncConnectorSchedules(db, definitionId, graph);

  return { definitionId };
}

export async function getDefinition(
  db: Db,
  definitionId: string
): Promise<{ _id: string; graph: NormalizedGraph } | null> {
  const { ProcessDefinitions } = getCollections(db);
  const doc = await ProcessDefinitions.findOne(
    { _id: definitionId },
    { projection: { _id: 1, graph: 1 } }
  );
  return doc as { _id: string; graph: NormalizedGraph } | null;
}

export async function getDefinitionByIdAndVersion(
  db: Db,
  id: string,
  version?: string
): Promise<{ _id: string; graph: NormalizedGraph } | null> {
  const { ProcessDefinitions } = getCollections(db);
  if (version != null && version !== '') {
    const doc = await ProcessDefinitions.findOne(
      { id, version },
      { projection: { _id: 1, graph: 1 } }
    );
    return doc as { _id: string; graph: NormalizedGraph } | null;
  }
  const doc = await ProcessDefinitions.findOne(
    { id },
    { sort: { deployedAt: -1 }, projection: { _id: 1, graph: 1 } }
  );
  return doc as { _id: string; graph: NormalizedGraph } | null;
}
