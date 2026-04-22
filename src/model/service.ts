import { v4 as uuidv4 } from 'uuid';
import { parseBpmnXml } from './parser';
import type { NodeDef, NormalizedGraph } from './types';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';
import { config } from '../config';
import { getDefaultTriggerRegistry, type TriggerRegistry } from '../triggers';
import type {
  BpmnStartEventView,
  StartTrigger,
  TriggerDefinition,
  TriggerSchedule as TriggerScheduleShape,
} from '../triggers/types';

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

function buildTimingFields(
  timing: TriggerScheduleShape,
): Record<string, unknown> {
  if (timing.kind === 'fire-at') {
    return { nextFireAt: timing.at };
  }
  return { intervalMs: timing.ms };
}

/** Map a BPMN event-definition $type string to the stable `kind` we expose to plugins. */
function eventDefinitionKind(node: NodeDef): BpmnStartEventView['eventDefinitionKind'] {
  const ed = node.eventDefinition;
  if (!ed) return 'none';
  if (ed === 'bpmn:TimerEventDefinition') return 'timer';
  if (ed === 'bpmn:MessageEventDefinition') return 'message';
  if (ed === 'bpmn:ConditionalEventDefinition') return 'conditional';
  if (ed === 'bpmn:SignalEventDefinition') return 'signal';
  return 'other';
}

function viewOf(node: NodeDef): BpmnStartEventView {
  return {
    nodeId: node.id,
    timerDefinition: node.timerDefinition,
    eventDefinitionKind: eventDefinitionKind(node),
    selfAttrs: node.selfAttrs ?? {},
    messageAttrs: node.messageAttrs,
  };
}

/**
 * Resolve, for each start event, the registered trigger (if any) that
 * claims it — together with the config the trigger wants to persist. The
 * engine never names trigger types or extension attributes in this step:
 * every plugin owns its own recognition logic via {@link StartTrigger.claimFromBpmn}.
 */
function resolveTriggerClaims(
  graph: NormalizedGraph,
  registry: TriggerRegistry,
): Array<{
  node: NodeDef;
  trigger: StartTrigger;
  config: Record<string, unknown>;
}> {
  const plugins = registry.list();
  const claims: Array<{
    node: NodeDef;
    trigger: StartTrigger;
    config: Record<string, unknown>;
  }> = [];
  for (const id of graph.startNodeIds) {
    const node = graph.nodes[id];
    if (!node || node.type !== 'startEvent') continue;
    const view = viewOf(node);
    let winner: { trigger: StartTrigger; config: Record<string, unknown> } | null = null;
    for (const trigger of plugins) {
      const claim = trigger.claimFromBpmn(view);
      if (!claim) continue;
      if (winner) {
        throw new Error(
          `Start event "${node.id}" is claimed by multiple triggers ` +
            `("${winner.trigger.triggerType}" and "${trigger.triggerType}"). ` +
            `Each start event may carry at most one trigger.`,
        );
      }
      winner = { trigger, config: claim.config };
    }
    if (winner) {
      claims.push({ node, trigger: winner.trigger, config: winner.config });
    }
  }
  return claims;
}

/**
 * Write/refresh TriggerSchedule rows for every start event that a registered
 * trigger claims. Engine core has zero knowledge of trigger types or
 * extension-attribute vocabularies — it delegates entirely to plugins via
 * {@link StartTrigger.claimFromBpmn}.
 *
 * Orphan rows (start events removed from the BPMN, or whose claiming trigger
 * was deregistered) are deleted.
 */
async function syncTriggerSchedules(
  db: Db,
  definitionId: string,
  graph: NormalizedGraph,
): Promise<void> {
  const { TriggerSchedules } = getCollections(db);
  const registry = getDefaultTriggerRegistry();

  const claims = resolveTriggerClaims(graph, registry);

  // Sanity: start events that parse as timers MUST be claimed by some trigger —
  // otherwise the host silently loses timer semantics on deploy.
  for (const id of graph.startNodeIds) {
    const node = graph.nodes[id];
    if (!node || node.type !== 'startEvent') continue;
    if (!node.timerDefinition) continue;
    const claimed = claims.some((c) => c.node.id === id);
    if (!claimed) {
      throw new Error(
        `Start event "${id}" has a timer event definition but no registered ` +
          `trigger claimed it. Did you forget to register the TimerTrigger?`,
      );
    }
  }

  const now = new Date();
  const activeStartEventIds = claims.map((c) => c.node.id);
  await TriggerSchedules.deleteMany({
    definitionId,
    ...(activeStartEventIds.length > 0
      ? { startEventId: { $nin: activeStartEventIds } }
      : {}),
  });

  for (const { node, trigger, config } of claims) {
    const def: TriggerDefinition = {
      triggerType: trigger.triggerType,
      definitionId,
      startEventId: node.id,
      config,
    };

    trigger.validate(def);

    const timing = trigger.nextSchedule(def, null, null);
    const setFields = buildTimingFields(timing);

    // Interpretation: when a plugin opts in with `deployStatus`, redeploying
    // the BPMN re-asserts that status on every call (e.g. timer → 'ACTIVE').
    // When omitted, we default to 'PAUSED' on first insert but preserve the
    // existing status across redeploys — the host likely flipped it to ACTIVE
    // via activateSchedules() after configuring credentials, and redeploying
    // the same BPMN shouldn't undo that.
    const forcedStatus = trigger.deployStatus;
    const setClause: Record<string, unknown> = {
      config: def.config,
      updatedAt: now,
      ...setFields,
    };
    if (forcedStatus !== undefined) {
      setClause.status = forcedStatus;
    }

    await TriggerSchedules.updateOne(
      { definitionId, startEventId: node.id, triggerType: trigger.triggerType },
      {
        $set: setClause,
        $setOnInsert: {
          _id: uuidv4(),
          scheduleId: uuidv4(),
          definitionId,
          startEventId: node.id,
          triggerType: trigger.triggerType,
          cursor: null,
          credentials: null,
          initialPolicy: trigger.defaultInitialPolicy,
          createdAt: now,
          ...(forcedStatus === undefined ? { status: 'PAUSED' } : {}),
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
    await syncTriggerSchedules(db, existing._id, graph);
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

  await syncTriggerSchedules(db, definitionId, graph);

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
