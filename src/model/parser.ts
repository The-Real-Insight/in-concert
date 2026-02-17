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
  return (timer as { timeCycle?: string; timeDuration?: string }).timeCycle
    ?? (timer as { timeDuration?: string }).timeDuration
    ?? undefined;
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
  const process = processes[0] as { id: string; flowElements?: unknown[] };

  const flowElements = process.flowElements ?? [];
  const nodes: Record<string, NodeDef> = {};
  const flows: Record<string, FlowDef> = {};
  const startNodeIds: string[] = [];

  for (const el of flowElements) {
    const flowEl = el as { $type?: string; id: string; name?: string; sourceRef?: string; targetRef?: string };
    const type = flowEl.$type ?? '';

    if (type === 'bpmn:SequenceFlow') {
      const src = flowEl.sourceRef as { id?: string } | string | undefined;
      const tgt = flowEl.targetRef as { id?: string } | string | undefined;
      flows[flowEl.id] = {
        id: flowEl.id,
        sourceRef: (typeof src === 'object' ? src?.id : src) ?? '',
        targetRef: (typeof tgt === 'object' ? tgt?.id : tgt) ?? '',
        name: flowEl.name,
      };
      continue;
    }

    if (!SUPPORTED_NODE_TYPES.has(type)) {
      continue;
    }

    const incoming = resolveIncoming(el as { incoming?: { id: string }[] });
    const outgoing = resolveOutgoing(el as { outgoing?: { id: string }[] });

    const node: NodeDef = {
      id: flowEl.id,
      type: getNodeType(type),
      name: flowEl.name,
      incoming,
      outgoing,
    };

    if (type === 'bpmn:StartEvent') {
      startNodeIds.push(flowEl.id);
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

    nodes[flowEl.id] = node;
  }

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
    metadata: {
      incomingByNode,
      outgoingByNode,
    },
  };
}
