export type NodeDef = {
  id: string;
  type: string;
  name?: string;
  laneRef?: string; // lane name (role) from BPMN laneSet
  /** For nodes inside an embedded subprocess: the subprocess node id. */
  parentNodeId?: string;
  incoming: string[];
  outgoing: string[];
  /** For exclusiveGateway: the flow id used when no condition matches. */
  defaultFlowId?: string;
  attachedToRef?: string;
  timerDefinition?: string;
  messageRef?: string;
  eventDefinition?: string;
  /** Custom extension attributes from BPMN (e.g. tri:toolId, tri:toolType). */
  extensions?: Record<string, string>;
};

export type FlowDef = {
  id: string;
  sourceRef: string;
  targetRef: string;
  name?: string;
  /** Condition expression from BPMN (e.g. \${approved}) for XOR routing. */
  conditionExpression?: string;
};

export type NormalizedGraph = {
  processId: string;
  nodes: Record<string, NodeDef>;
  flows: Record<string, FlowDef>;
  startNodeIds: string[];
  /** Subprocess node id -> start event id(s) inside it. */
  subprocessStartNodeIds?: Record<string, string[]>;
  metadata: {
    incomingByNode: Record<string, string[]>;
    outgoingByNode: Record<string, string[]>;
    upstreamSetByOrJoinIncoming?: Record<string, Record<string, string[]>>;
  };
};
