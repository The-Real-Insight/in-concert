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
 * Per-tenant model: deploy writes exactly one row per start event, keyed to
 * the **owner tenant** (the definition's `tenantId`). Rows owned by other
 * tenants (created when those tenants called `activateSchedules`) are NOT
 * touched — redeploying an owner's workflow never clobbers procurer state.
 *
 * Orphan rows (start events removed from the BPMN, or whose claiming trigger
 * was deregistered) are deleted *only for the owner tenant*. Procurer rows
 * for a removed start event are left alone — they'll reject at activate time
 * the next time the tenant tries to fire them (the start event is gone).
 */
async function syncTriggerSchedules(
  db: Db,
  definitionId: string,
  graph: NormalizedGraph,
  ownerTenantId: string | undefined,
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
  // Scope the orphan cleanup to the owner tenant: redeploying the owner's
  // workflow must not remove procurer rows (which may still be valid until
  // those tenants re-activate or their workflow gets removed).
  await TriggerSchedules.deleteMany({
    definitionId,
    startingTenantId: ownerTenantId,
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

    // Match filter uses `$eq` + `{ $exists: false }` fallback so undefined
    // ownerTenantId (legacy / demo deploys) matches the single no-tenant row.
    const matchFilter: Record<string, unknown> = {
      definitionId,
      startEventId: node.id,
      triggerType: trigger.triggerType,
    };
    if (ownerTenantId) {
      matchFilter.startingTenantId = ownerTenantId;
    } else {
      matchFilter.$or = [
        { startingTenantId: { $exists: false } },
        { startingTenantId: null },
      ];
    }

    // Only write startingTenantId on insert when we have one — otherwise
    // Mongo persists an explicit `null` and `listTriggerSchedules()` sees a
    // row indistinguishable from the per-tenant shape. Undefined stays
    // omitted from the doc, matching the legacy test's expectations.
    const setOnInsertBase: Record<string, unknown> = {
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
    };
    if (ownerTenantId) setOnInsertBase.startingTenantId = ownerTenantId;

    await TriggerSchedules.updateOne(
      matchFilter,
      { $set: setClause, $setOnInsert: setOnInsertBase },
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
    await syncTriggerSchedules(db, existing._id, graph, params.tenantId);
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

  await syncTriggerSchedules(db, definitionId, graph, params.tenantId);

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
