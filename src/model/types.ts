export type NodeDef = {
  id: string;
  type: string;
  name?: string;
  laneRef?: string; // lane name (role) from BPMN laneSet
  /** tri:roleId from pool/lane; used for worklist filtering by user roleAssignments */
  roleId?: string;
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
  /** Custom extension attributes from BPMN (e.g. tri:toolId, tri:toolType, tri:parameterOverwrites). */
  extensions?: Record<string, string>;
  /** Multi-instance metadata when tri:multiInstanceData is present. */
  multiInstance?: { data?: string };
  /**
   * Raw `tri:*` attribute bag from the BPMN element itself (start event,
   * intermediate event, etc.) and any nested `<bpmn:*EventDefinition>`.
   * Keys are fully qualified (`tri:connectorType`, `tri:path`, …). The
   * engine never interprets these — trigger plugins read what they need.
   */
  selfAttrs?: Record<string, string>;
  /**
   * Raw `tri:*` attribute bag from the referenced `bpmn:Message`, when a
   * message event definition points at one. Same engine-agnostic contract
   * as {@link selfAttrs}.
   */
  messageAttrs?: Record<string, string>;
};

export type FlowDef = {
  id: string;
  sourceRef: string;
  targetRef: string;
  name?: string;
  /** Condition expression from BPMN (e.g. \${approved}) for XOR routing. */
  conditionExpression?: string;
  /**
   * Extension attributes on the `<bpmn:sequenceFlow>` opening tag under any
   * non-reserved namespace, keyed fully qualified (`<prefix>:<name>`, e.g.
   * `acme:condition1`, `myco:weight`). The engine does not interpret these
   * — it surfaces them so the `CALLBACK_DECISION` payload can forward them
   * to the host's `onDecision` handler. Authors choose their own namespace
   * and vocabulary.
   */
  selfAttrs?: Record<string, string>;
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
