// bpmn-moddle uses module.exports = function (constructor)
const BpmnModdle = require('bpmn-moddle') as new () => {
  fromXML: (xml: string) => Promise<{ rootElement: unknown }>;
};
import type { NormalizedGraph, NodeDef, FlowDef } from './types';

const SUPPORTED_NODE_TYPES = new Set([
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:InclusiveGateway',
  'bpmn:ServiceTask',
  'bpmn:UserTask',
  'bpmn:SubProcess',
  'bpmn:CallActivity',
  'bpmn:IntermediateCatchEvent',
  'bpmn:IntermediateThrowEvent',
  'bpmn:BoundaryEvent',
]);

function getNodeType(bpmnType: string): string {
  const map: Record<string, string> = {
    'bpmn:StartEvent': 'startEvent',
    'bpmn:EndEvent': 'endEvent',
    'bpmn:ExclusiveGateway': 'exclusiveGateway',
    'bpmn:ParallelGateway': 'parallelGateway',
    'bpmn:InclusiveGateway': 'inclusiveGateway',
    'bpmn:ServiceTask': 'serviceTask',
    'bpmn:UserTask': 'userTask',
    'bpmn:SubProcess': 'subProcess',
    'bpmn:CallActivity': 'callActivity',
    'bpmn:IntermediateCatchEvent': 'intermediateCatchEvent',
    'bpmn:IntermediateThrowEvent': 'intermediateThrowEvent',
    'bpmn:BoundaryEvent': 'boundaryEvent',
  };
  return map[bpmnType] ?? 'unknown';
}

function resolveIncoming(el: { incoming?: { id: string }[] }): string[] {
  const incoming = el.incoming;
  if (!incoming || !Array.isArray(incoming)) return [];
  return incoming.map((f: { id: string }) => f.id);
}

function resolveOutgoing(el: { outgoing?: { id: string }[] }): string[] {
  const outgoing = el.outgoing;
  if (!outgoing || !Array.isArray(outgoing)) return [];
  return outgoing.map((f: { id: string }) => f.id);
}

function getTimerDefinition(el: { eventDefinitions?: unknown[] }): string | undefined {
  const defs = el.eventDefinitions;
  if (!defs?.length) return undefined;
  const timer = defs.find((d) => (d as { $type?: string }).$type === 'bpmn:TimerEventDefinition');
  if (!timer) return undefined;
  type TimerChild = string | { body?: string } | undefined;
  const t = timer as { timeCycle?: TimerChild; timeDuration?: TimerChild; timeDate?: TimerChild };
  const raw = t.timeCycle ?? t.timeDuration ?? t.timeDate;
  if (raw == null) return undefined;
  return typeof raw === 'string' ? raw : raw.body;
}

function getMessageRef(el: { messageRef?: { name?: string }; eventDefinitions?: unknown[] }): string | undefined {
  const defs = el.eventDefinitions;
  if (!defs?.length) return undefined;
  const msg = defs.find((d) => (d as { $type?: string }).$type === 'bpmn:MessageEventDefinition');
  if (!msg) return undefined;
  const ref = (msg as { messageRef?: { name?: string } }).messageRef;
  return ref?.name ?? undefined;
}

function getEventDefinition(el: { eventDefinitions?: { $type?: string }[] }): string | undefined {
  const defs = el.eventDefinitions;
  if (!defs?.length) return undefined;
  return defs[0]?.$type ?? undefined;
}

/** Decode a small subset of XML entities used in BPMN attribute values (e.g. tri:condition). */
function decodeXmlEntitiesInAttribute(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * TRI extension: sequence flows may carry `tri:condition="..."` on the opening/self-closing tag
 * (modeller output) instead of nested `<bpmn:conditionExpression>`.
 */
function parseTriConditionAttributesByFlow(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tagRe = /<bpmn:sequenceFlow(\s[^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1] ?? '';
    const idMatch = /\bid="([^"]+)"/i.exec(attrs);
    const condMatch = /\btri:condition="([^"]*)"/i.exec(attrs);
    const flowId = idMatch?.[1];
    if (!flowId) continue;
    const raw = condMatch?.[1];
    if (raw == null) continue;
    const decoded = decodeXmlEntitiesInAttribute(raw);
    // Empty tri:condition="" skips; do not trim() so trailing &#10; etc. stay meaningful for NL conditions.
    if (decoded.replace(/\s/g, '').length === 0) continue;
    result[flowId] = decoded;
  }
  return result;
}

/** Extract conditionExpression per flow id from BPMN XML (bpmn-moddle may not expose it). */
function parseConditionExpressionsByFlow(xml: string): Record<string, string> {
  const fromNested: Record<string, string> = {};
  const condRe =
    /<bpmn:sequenceFlow\s+id="([^"]+)"[^>]*>\s*<bpmn:conditionExpression[^>]*>\s*(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]+))/gi;
  let m;
  while ((m = condRe.exec(xml))) {
    const flowId = m[1];
    const body = (m[2] ?? m[3] ?? '').trim();
    if (body) fromNested[flowId] = body;
  }
  const fromTri = parseTriConditionAttributesByFlow(xml);
  // Nested BPMN 2.0 conditionExpression wins over tri:condition when both are present.
  return { ...fromTri, ...fromNested };
}

/** Parse lane elements from BPMN XML to extract id, name, tri:roleId. */
function parseLanesFromXml(xml: string): { id: string; name?: string; roleId?: string }[] {
  const result: { id: string; name?: string; roleId?: string }[] = [];
  const laneRe = /<bpmn:lane\s+id="([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = laneRe.exec(xml))) {
    const attrs = m[2] ?? '';
    const name = attrs.match(/name="([^"]*)"/)?.[1]?.trim();
    const roleId = attrs.match(/tri:roleId="([^"]*)"/)?.[1]?.trim();
    result.push({ id: m[1]!, name, roleId });
  }
  return result;
}

/** Parse participant (pool) elements from BPMN XML to extract id, name, processRef, tri:roleId. */
function parseParticipantsFromXml(xml: string): { id: string; name?: string; processRef?: string; roleId?: string }[] {
  const result: { id: string; name?: string; processRef?: string; roleId?: string }[] = [];
  const participantRe = /<bpmn:participant\s+id="([^"]+)"([^>]*)\/?>/gi;
  let m;
  while ((m = participantRe.exec(xml))) {
    const attrs = m[2] ?? '';
    const name = attrs.match(/name="([^"]*)"/)?.[1]?.trim();
    const processRef = attrs.match(/processRef="([^"]*)"/)?.[1]?.trim();
    const roleId = attrs.match(/tri:roleId="([^"]*)"/)?.[1]?.trim();
    result.push({ id: m[1]!, name, processRef, roleId });
  }
  return result;
}

/**
 * Extension-attribute namespace prefixes the parser ignores. Everything
 * under these belongs to the BPMN spec, diagram interchange, or XML
 * itself — never plugin-visible extension data.
 */
const RESERVED_NS_PREFIXES = new Set([
  'bpmn',
  'bpmndi',
  'dc',
  'di',
  'xsi',
  'xml',
  'xmlns',
]);

/**
 * Pull every `<prefix>:<name>="value"` attribute out of a tag's attribute
 * string, except those under reserved namespaces. The engine stores these
 * verbatim so plugins can recognize whatever vocabulary their host chose
 * (TRI's own bundled plugins use `tri:`, but `acme:`, `myco:`, etc. work
 * identically).
 */
function extractNamespacedAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attrRe = /(\w+):(\w+)="([^"]*)"/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(attrs)) !== null) {
    const prefix = am[1]!;
    if (RESERVED_NS_PREFIXES.has(prefix)) continue;
    const name = am[2]!;
    out[`${prefix}:${name}`] = decodeXmlEntitiesInAttribute(am[3]!).trim();
  }
  return out;
}

/**
 * Parse `bpmn:message` elements from XML, returning their extension
 * attributes keyed by the message's `name` (falling back to `id`).
 * Engine-agnostic — no filtering by connector discriminator, no hard-
 * coded namespace prefix; plugins decide what to claim from the raw bag.
 * Keys are fully qualified (`<prefix>:<name>`).
 */
function parseMessageAttrs(xml: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const msgRe = /<bpmn:message\s+id="([^"]+)"([^>]*)\/?>/gi;
  let m;
  while ((m = msgRe.exec(xml))) {
    const msgId = m[1]!;
    const attrs = m[2] ?? '';
    const ext = extractNamespacedAttrs(attrs);
    if (Object.keys(ext).length > 0) {
      const nameMatch = attrs.match(/name="([^"]*)"/)?.[1];
      const key = nameMatch ?? msgId;
      result[key] = ext;
    }
  }
  return result;
}

/**
 * Parse extension attributes from `<bpmn:startEvent>` opening tags and from
 * any nested event-definition children (`<bpmn:conditionalEventDefinition acme:… />`).
 * Keyed by start-event id. Engine-agnostic; any non-reserved namespace
 * is captured verbatim.
 */
function parseStartEventSelfAttrs(xml: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const tagRe = /<bpmn:startEvent\s+id="([^"]+)"([^>]*?)(\/?)>([\s\S]*?)<\/bpmn:startEvent>|<bpmn:startEvent\s+id="([^"]+)"([^>]*?)\/>/gi;
  let m;
  while ((m = tagRe.exec(xml))) {
    const id = m[1] ?? m[5]!;
    const openAttrs = (m[2] ?? m[6]) ?? '';
    const inner = m[4] ?? '';
    const ext: Record<string, string> = { ...extractNamespacedAttrs(openAttrs) };
    if (inner) {
      // Walk nested event-definition elements for their extension attributes.
      const defRe = /<bpmn:\w+EventDefinition\b([^>]*?)\/?>/gi;
      let dm;
      while ((dm = defRe.exec(inner))) {
        const defAttrs = dm[1] ?? '';
        Object.assign(ext, extractNamespacedAttrs(defAttrs));
      }
    }
    if (Object.keys(ext).length > 0) {
      result[id] = ext;
    }
  }
  return result;
}

/** Extract custom extension attributes (ns:attr) from task nodes. Generic—no tri-specific logic. */
function parseExtensionAttributesByNode(xml: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const tagRe = /<(?:bpmn:serviceTask|bpmn:userTask)\s+id="([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(xml))) {
    const nodeId = m[1];
    const attrs = m[2] ?? '';
    const ext: Record<string, string> = {};
    const attrRe = /(\w+:\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrs))) {
      ext[am[1]!] = am[2]!.trim();
    }
    if (Object.keys(ext).length) result[nodeId] = ext;
  }
  return result;
}

export async function parseBpmnXml(xml: string): Promise<NormalizedGraph> {
  const moddle = new BpmnModdle();
  const { rootElement: definitions } = await moddle.fromXML(xml);

  const rootElements = (definitions as { rootElements?: unknown[] }).rootElements ?? [];
  const processes = rootElements.filter(
    (el): el is { $type: string; id: string; flowElements?: unknown[] } =>
      (el as { $type?: string }).$type === 'bpmn:Process'
  );
  if (processes.length === 0) {
    throw new Error('No process found in BPMN');
  }
  const process = processes[0] as {
    id: string;
    flowElements?: unknown[];
    laneSets?: { lanes?: { id: string; name?: string; flowNodeRef?: unknown[] }[] }[];
  };

  const lanesParsed = parseLanesFromXml(xml);
  const laneIdToRole: Record<string, { roleName: string; roleId?: string }> = {};
  for (const l of lanesParsed) {
    laneIdToRole[l.id] = {
      roleName: l.name ?? l.id,
      roleId: l.roleId,
    };
  }

  const nodeIdToLaneRole: Record<string, { roleName: string; roleId?: string }> = {};
  const laneSets = process.laneSets ?? [];
  for (const ls of laneSets) {
    const lanes = ls.lanes ?? [];
    for (const lane of lanes) {
      const role = laneIdToRole[lane.id] ?? { roleName: lane.name ?? lane.id };
      const refs: unknown[] = lane.flowNodeRef ?? [];
      for (const ref of refs) {
        const nodeId = typeof ref === 'string' ? ref : (ref as { id?: string })?.id;
        if (nodeId) nodeIdToLaneRole[nodeId] = role;
      }
    }
  }

  // Fallback: when no lanes exist, inherit tri:roleId from the participant (pool) whose processRef matches this process.
  const participantsParsed = parseParticipantsFromXml(xml);
  let participantFallbackRole: { roleName: string; roleId?: string } | undefined;
  if (Object.keys(nodeIdToLaneRole).length === 0) {
    const participant = participantsParsed.find((p) => p.processRef === process.id && p.roleId);
    if (participant) {
      participantFallbackRole = { roleName: participant.name ?? participant.id, roleId: participant.roleId };
    }
  }

  const flowElements = process.flowElements ?? [];
  const nodes: Record<string, NodeDef> = {};
  const flows: Record<string, FlowDef> = {};
  const startNodeIds: string[] = [];
  const subprocessStartNodeIds: Record<string, string[]> = {};
  const conditionByFlow = parseConditionExpressionsByFlow(xml);
  const messageAttrsByName = parseMessageAttrs(xml);
  const startEventSelfAttrs = parseStartEventSelfAttrs(xml);
  const extensionByNode = parseExtensionAttributesByNode(xml);

  function processFlowElements(
    elements: unknown[],
    parentSubprocessId?: string
  ): void {
    for (const el of elements) {
      const flowEl = el as {
        $type?: string;
        id: string;
        name?: string;
        flowElements?: unknown[];
        sourceRef?: string | { id?: string };
        targetRef?: string | { id?: string };
        default?: { id?: string } | string;
      };
      const type = flowEl.$type ?? '';

      if (type === 'bpmn:SequenceFlow') {
        const src = flowEl.sourceRef as { id?: string } | string | undefined;
        const tgt = flowEl.targetRef as { id?: string } | string | undefined;
        flows[flowEl.id] = {
          id: flowEl.id,
          sourceRef: (typeof src === 'object' ? src?.id : src) ?? '',
          targetRef: (typeof tgt === 'object' ? tgt?.id : tgt) ?? '',
          name: flowEl.name,
          conditionExpression: conditionByFlow[flowEl.id],
        };
        continue;
      }

      if (!SUPPORTED_NODE_TYPES.has(type)) {
        continue;
      }

      const incoming = resolveIncoming(el as { incoming?: { id: string }[] });
      const outgoing = resolveOutgoing(el as { outgoing?: { id: string }[] });

      const laneRole = nodeIdToLaneRole[flowEl.id] ?? participantFallbackRole;
      const node: NodeDef = {
        id: flowEl.id,
        type: getNodeType(type),
        name: flowEl.name,
        laneRef: laneRole?.roleName,
        roleId: laneRole?.roleId,
        incoming,
        outgoing,
      };
      if (parentSubprocessId) {
        node.parentNodeId = parentSubprocessId;
      }

      if (type === 'bpmn:StartEvent') {
        node.timerDefinition = getTimerDefinition(el as { eventDefinitions?: unknown[] });
        node.messageRef = getMessageRef(el as { messageRef?: { name?: string }; eventDefinitions?: unknown[] });
        node.eventDefinition = getEventDefinition(el as { eventDefinitions?: { $type?: string }[] });
        const selfAttrs = startEventSelfAttrs[flowEl.id];
        if (selfAttrs && Object.keys(selfAttrs).length > 0) {
          node.selfAttrs = selfAttrs;
        }
        if (node.messageRef && messageAttrsByName[node.messageRef]) {
          node.messageAttrs = messageAttrsByName[node.messageRef];
        }
        if (parentSubprocessId) {
          if (!subprocessStartNodeIds[parentSubprocessId])
            subprocessStartNodeIds[parentSubprocessId] = [];
          subprocessStartNodeIds[parentSubprocessId].push(flowEl.id);
        } else {
          startNodeIds.push(flowEl.id);
        }
      }

      if (type === 'bpmn:ExclusiveGateway') {
        const def = flowEl.default;
        node.defaultFlowId =
          typeof def === 'object' && def != null ? (def as { id?: string }).id : (def as string | undefined);
      }

      if (type === 'bpmn:IntermediateCatchEvent') {
        node.timerDefinition = getTimerDefinition(el as { eventDefinitions?: unknown[] });
        node.messageRef = getMessageRef(el as { messageRef?: { name?: string }; eventDefinitions?: unknown[] });
        node.eventDefinition = getEventDefinition(el as { eventDefinitions?: { $type?: string }[] });
      }

      if (type === 'bpmn:IntermediateThrowEvent') {
        node.messageRef = getMessageRef(el as { messageRef?: { name?: string }; eventDefinitions?: unknown[] });
      }

      if (type === 'bpmn:BoundaryEvent') {
        const boundaryEl = el as { attachedToRef?: { id: string } | string; eventDefinitions?: unknown[]; cancelActivity?: boolean };
        const attachedTo = boundaryEl.attachedToRef;
        node.attachedToRef = typeof attachedTo === 'string' ? attachedTo : attachedTo?.id;
        node.timerDefinition = getTimerDefinition(boundaryEl);
        node.eventDefinition = getEventDefinition(boundaryEl as { eventDefinitions?: { $type?: string }[] });
        const isInterrupting = boundaryEl.cancelActivity !== false;
        (node as NodeDef & { interrupting?: boolean }).interrupting = isInterrupting;
      }

      const nodeExtensions = extensionByNode[flowEl.id];
      if (nodeExtensions) {
        node.extensions = nodeExtensions;
        const miData = nodeExtensions['tri:multiInstanceData'];
        if (miData != null && (type === 'bpmn:ServiceTask' || type === 'bpmn:UserTask')) {
          node.multiInstance = { data: miData };
        }
      }

      nodes[flowEl.id] = node;

      if (type === 'bpmn:SubProcess') {
        const inner = flowEl.flowElements ?? [];
        processFlowElements(inner, flowEl.id);
      }
    }
  }

  processFlowElements(flowElements);

  const incomingByNode: Record<string, string[]> = {};
  const outgoingByNode: Record<string, string[]> = {};

  for (const [flowId, flow] of Object.entries(flows)) {
    if (!incomingByNode[flow.targetRef]) incomingByNode[flow.targetRef] = [];
    incomingByNode[flow.targetRef].push(flowId);
    if (!outgoingByNode[flow.sourceRef]) outgoingByNode[flow.sourceRef] = [];
    outgoingByNode[flow.sourceRef].push(flowId);
  }

  return {
    processId: process.id,
    nodes,
    flows,
    startNodeIds,
    subprocessStartNodeIds: Object.keys(subprocessStartNodeIds).length ? subprocessStartNodeIds : undefined,
    metadata: {
      incomingByNode,
      outgoingByNode,
    },
  };
}
