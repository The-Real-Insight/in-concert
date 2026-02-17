import { Db, Collection } from 'mongodb';

export const COLLECTION_NAMES = {
  ProcessDefinitions: 'ProcessDefinitions',
  ProcessInstances: 'ProcessInstances',
  ProcessInstanceState: 'ProcessInstanceState',
  ProcessInstanceEvents: 'ProcessInstanceEvents',
  Continuations: 'Continuations',
  Outbox: 'Outbox',
} as const;

export type ProcessDefinitionDoc = {
  _id: string;
  tenantId?: string;
  name: string;
  version: number;
  bpmnXml?: string;
  graph: NormalizedGraph;
  createdAt: Date;
};

export type ProcessInstanceDoc = {
  _id: string;
  definitionId: string;
  tenantId?: string;
  rootInstanceId: string;
  parentInstanceId?: string;
  parentCallActivityId?: string;
  businessKey?: string;
  status: 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  createdAt: Date;
  endedAt?: Date;
};

export type TokenStatus = 'ACTIVE' | 'WAITING' | 'CONSUMED';
export type WorkItemStatus = 'OPEN' | 'COMPLETED' | 'FAILED' | 'CANCELED';
export type ContinuationStatus = 'READY' | 'IN_PROGRESS' | 'DONE' | 'DEAD';
export type OutboxStatus = 'READY' | 'SENT' | 'RETRY' | 'DEAD';

export type Token = {
  tokenId: string;
  nodeId: string;
  scopeId: string;
  status: TokenStatus;
  createdAt: Date;
  activation?: { orSplitId: string };
};

export type Scope = {
  scopeId: string;
  kind: 'ROOT' | 'SUBPROCESS';
  nodeId?: string;
  parentScopeId?: string;
};

export type WorkItemRef = {
  workItemId: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  kind: 'SERVICE_TASK' | 'USER_TASK' | 'CALL_ACTIVITY';
  status: WorkItemStatus;
  createdAt: Date;
  correlationHints?: Record<string, unknown>;
};

export type MessageSubRef = {
  subscriptionId: string;
  messageName: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  correlationKeys?: Record<string, unknown>;
  createdAt: Date;
};

export type TimerRef = {
  timerId: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  dueAt: Date;
  isBoundary: boolean;
  boundary?: {
    attachedToNodeId: string;
    interrupting: boolean;
  };
  createdAt: Date;
};

export type DecisionKind =
  | 'XOR_SPLIT'
  | 'OR_SPLIT'
  | 'EVENT_BASED_ARM'
  | 'CORRELATION_KEYS';

export type PendingDecisionRef = {
  decisionId: string;
  kind: DecisionKind;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  optionsHash: string;
  contextRef?: string;
  createdAt: Date;
};

export type ProcessInstanceStateDoc = {
  _id: string;
  version: number;
  status: 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  tokens: Token[];
  scopes: Scope[];
  waits: {
    workItems: WorkItemRef[];
    messageSubs: MessageSubRef[];
    timers: TimerRef[];
    decisions: PendingDecisionRef[];
  };
  dedupe: {
    processedCommandIds: string[];
    completedWorkItemIds: string[];
    processedMessageIds: string[];
    recordedDecisionIds: string[];
  };
  lastEventSeq: number;
  updatedAt: Date;
  joinArrivals?: Record<string, Record<string, Record<string, string>>>; // joinNodeId -> scopeId -> flowId -> tokenId
};

export type ProcessInstanceEventDoc = {
  _id?: string;
  instanceId: string;
  seq: number;
  type: string;
  at: Date;
  payload: Record<string, unknown>;
};

export type ContinuationKind =
  | 'START'
  | 'TOKEN_AT_NODE'
  | 'TIMER_DUE'
  | 'MESSAGE'
  | 'WORK_COMPLETED'
  | 'DECISION_RECORDED';

export type ContinuationDoc = {
  _id: string;
  instanceId: string;
  dueAt: Date;
  kind: ContinuationKind;
  payload: Record<string, unknown>;
  status: ContinuationStatus;
  ownerId?: string;
  leaseUntil?: Date;
  attempts: number;
  dedupeKey?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type OutboxKind = 'CALLBACK_WORK' | 'CALLBACK_DECISION' | 'CALLBACK_EVENT';

export type OutboxDoc = {
  _id: string;
  instanceId: string;
  rootInstanceId: string;
  kind: OutboxKind;
  destination: { url: string; headers?: Record<string, string> };
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

export type NodeDef = {
  id: string;
  type: string;
  name?: string;
  laneRef?: string;
  incoming: string[];
  outgoing: string[];
  attachedToRef?: string;
  timerDefinition?: string;
  messageRef?: string;
  eventDefinition?: string;
};

export type FlowDef = {
  id: string;
  sourceRef: string;
  targetRef: string;
  name?: string;
};

export type NormalizedGraph = {
  processId: string;
  nodes: Record<string, NodeDef>;
  flows: Record<string, FlowDef>;
  startNodeIds: string[];
  metadata: {
    incomingByNode: Record<string, string[]>;
    outgoingByNode: Record<string, string[]>;
    upstreamSetByOrJoinIncoming?: Record<string, Record<string, string[]>>;
  };
};

export function getCollections(database: Db) {
  return {
    ProcessDefinitions: database.collection<ProcessDefinitionDoc>(
      COLLECTION_NAMES.ProcessDefinitions
    ),
    ProcessInstances: database.collection<ProcessInstanceDoc>(
      COLLECTION_NAMES.ProcessInstances
    ),
    ProcessInstanceState: database.collection<ProcessInstanceStateDoc>(
      COLLECTION_NAMES.ProcessInstanceState
    ),
    ProcessInstanceEvents: database.collection<ProcessInstanceEventDoc>(
      COLLECTION_NAMES.ProcessInstanceEvents
    ),
    Continuations: database.collection<ContinuationDoc>(
      COLLECTION_NAMES.Continuations
    ),
    Outbox: database.collection<OutboxDoc>(COLLECTION_NAMES.Outbox),
  };
}
