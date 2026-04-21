import { v4 as uuidv4 } from 'uuid';
import { parseBpmnXml } from './parser';
import type { NormalizedGraph } from './types';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import { config } from '../config';
import { getDefaultTriggerRegistry } from '../triggers';
import type { TriggerDefinition, TriggerSchedule as TriggerScheduleShape } from '../triggers/types';

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

/**
 * Write/refresh TriggerSchedule rows for timer start events, driven by the
 * registered TimerTrigger. Replaces the pre-refactor syncTimerSchedules
 * which wrote into the now-deprecated TimerSchedule collection.
 */
async function syncTimerTriggerSchedules(
  db: Db,
  definitionId: string,
  graph: NormalizedGraph,
): Promise<void> {
  const { TriggerSchedules } = getCollections(db);
  const registry = getDefaultTriggerRegistry();
  const timerTrigger = registry.get('timer');
  if (!timerTrigger) {
    // Intentional: if a deployment embeds timers but the host stripped
    // the timer plugin, we surface that as a deploy error rather than
    // silently ignoring the BPMN's intent.
    const hasTimers = graph.startNodeIds.some((id) => graph.nodes[id]?.timerDefinition);
    if (hasTimers) {
      throw new Error(
        'BPMN contains timer start event(s) but no "timer" trigger is registered.',
      );
    }
    return;
  }

  const now = new Date();

  const timerStartNodes = graph.startNodeIds
    .map((id) => graph.nodes[id])
    .filter((n) => n?.type === 'startEvent' && n.timerDefinition);

  const activeTimerIds = timerStartNodes.map((n) => n.id);
  await TriggerSchedules.deleteMany({
    definitionId,
    triggerType: 'timer',
    ...(activeTimerIds.length > 0
      ? { startEventId: { $nin: activeTimerIds } }
      : {}),
  });

  for (const node of timerStartNodes) {
    const def: TriggerDefinition = {
      triggerType: 'timer',
      definitionId,
      startEventId: node.id,
      config: { expression: node.timerDefinition! },
    };

    // Let the plugin reject invalid expressions at deploy time.
    timerTrigger.validate(def);

    const timing = timerTrigger.nextSchedule(def, null, null);
    const setFields = buildTimingFields(timing);

    await TriggerSchedules.updateOne(
      { definitionId, startEventId: node.id, triggerType: 'timer' },
      {
        $set: {
          config: def.config,
          status: 'ACTIVE',
          updatedAt: now,
          ...setFields,
        },
        $setOnInsert: {
          _id: uuidv4(),
          scheduleId: uuidv4(),
          definitionId,
          startEventId: node.id,
          triggerType: 'timer',
          cursor: null,
          credentials: null,
          initialPolicy: timerTrigger.defaultInitialPolicy,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
}

function buildTimingFields(
  timing: TriggerScheduleShape,
): Record<string, unknown> {
  if (timing.kind === 'fire-at') {
    return { nextFireAt: timing.at };
  }
  return { intervalMs: timing.ms };
}

/**
 * Write/refresh TriggerSchedule rows for BPMN message start events whose
 * message carries a `tri:connectorType`. Each such start event is matched
 * against a registered StartTrigger via the default trigger registry.
 *
 * Replaces the pre-refactor syncConnectorSchedules which wrote into the
 * now-deprecated ConnectorSchedule collection.
 */
async function syncConnectorTriggerSchedules(
  db: Db,
  definitionId: string,
  graph: NormalizedGraph,
): Promise<void> {
  const { TriggerSchedules } = getCollections(db);
  const registry = getDefaultTriggerRegistry();
  const now = new Date();

  const connectorStartNodes = graph.startNodeIds
    .map((id) => graph.nodes[id])
    .filter((n) => n?.type === 'startEvent' && n.connectorConfig?.connectorType);

  // Remove any non-timer trigger rows whose start event is gone.
  const activeStartEventIds = connectorStartNodes.map((n) => n.id);
  await TriggerSchedules.deleteMany({
    definitionId,
    triggerType: { $ne: 'timer' },
    ...(activeStartEventIds.length > 0
      ? { startEventId: { $nin: activeStartEventIds } }
      : {}),
  });

  for (const node of connectorStartNodes) {
    const cc = node.connectorConfig!;
    const { connectorType, ...restConfig } = cc;
    const trigger = registry.get(connectorType);
    if (!trigger) {
      throw new Error(
        `BPMN references tri:connectorType="${connectorType}" but no such trigger is registered.`,
      );
    }

    const def: TriggerDefinition = {
      triggerType: connectorType,
      definitionId,
      startEventId: node.id,
      config: restConfig,
    };
    trigger.validate(def);

    const timing = trigger.nextSchedule(def, null, null);
    const setFields = buildTimingFields(timing);

    await TriggerSchedules.updateOne(
      { definitionId, startEventId: node.id, triggerType: connectorType },
      {
        $set: {
          config: def.config,
          updatedAt: now,
          ...setFields,
        },
        $setOnInsert: {
          _id: uuidv4(),
          scheduleId: uuidv4(),
          definitionId,
          startEventId: node.id,
          triggerType: connectorType,
          cursor: null,
          credentials: null,
          initialPolicy: trigger.defaultInitialPolicy,
          status: 'PAUSED', // deployed as PAUSED — host must call activate
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
          tenantId: params.tenantId,
          bpmnXml: params.bpmnXml,
          graph,
          deployedAt: now,
        },
      }
    );
    await syncTimerTriggerSchedules(db, existing._id, graph);
    await syncConnectorTriggerSchedules(db, existing._id, graph);
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

  await syncTimerTriggerSchedules(db, definitionId, graph);
  await syncConnectorTriggerSchedules(db, definitionId, graph);

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
