import { Db, Collection } from 'mongodb';

export const COLLECTION_NAMES = {
  ProcessDefinition: 'ProcessDefinition',
  ProcessInstance: 'ProcessInstance',
  ProcessInstanceState: 'ProcessInstanceState',
  ProcessInstanceEvent: 'ProcessInstanceEvent',
  ProcessInstanceHistory: 'ProcessInstanceHistory',
  Continuation: 'Continuation',
  Outbox: 'Outbox',
  HumanTask: 'HumanTask',
  TimerSchedule: 'TimerSchedule',
  ConnectorSchedule: 'ConnectorSchedule',
} as const;

/** Audit trail: one row per task/instance lifecycle event. */
export type ProcessInstanceHistoryDoc = {
  _id: string;
  instanceId: string;
  seq: number;
  eventType: 'INSTANCE_STARTED' | 'TASK_STARTED' | 'TASK_COMPLETED';
  at: Date;
  /** For INSTANCE_STARTED */
  startedBy?: string;
  startedByDetails?: UserDetails;
  /** For TASK_* */
  nodeId?: string;
  nodeName?: string;
  nodeType?: 'userTask' | 'serviceTask';
  workItemId?: string;
  scopeId?: string;
  /** For TASK_COMPLETED (user tasks) */
  completedBy?: string;
  completedByDetails?: UserDetails;
  result?: unknown;
  createdAt: Date;
};

export type HumanTaskStatus = 'OPEN' | 'CLAIMED' | 'COMPLETED' | 'CANCELED';

export type HumanTaskDoc = {
  _id: string;
  instanceId: string;
  conversationId?: string;
  definitionId?: string;
  nodeId: string;
  name: string;
  /** Lane/pool name (role display name) from BPMN */
  role?: string;
  /** tri:roleId from pool/lane; used for worklist filtering by user roleAssignments */
  roleId?: string;
  status: HumanTaskStatus;
  assigneeUserId?: string;
  /** Lane names for backward compatibility */
  candidateRoles?: string[];
  /** Role IDs (tri:roleId) for filtering by user.roleAssignments[].role */
  candidateRoleIds?: string[];
  createdAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
  completedBy?: string;
  completedByDetails?: UserDetails;
  canceledAt?: Date;
  result?: unknown;
  version: number;
};

export type ProcessDefinitionDoc = {
  _id: string;
  /** Business id (e.g. AgenticWorkflow._id). Unique per (id, version). */
  id: string;
  tenantId?: string;
  name: string;
  /** Version as string to support semantic versions (e.g. "1", "1.1", "2.0"). */
  version: string;
  bpmnXml?: string;
  graph: NormalizedGraph;
  createdAt: Date;
  /** When this version was deployed. Used to resolve "latest" = most recently deployed. */
  deployedAt: Date;
};

export type UserDetails = {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  photoUrl?: string;
};

export type ProcessInstanceDoc = {
  _id: string;
  definitionId: string;
  conversationId?: string;
  tenantId?: string;
  rootInstanceId: string;
  parentInstanceId?: string;
  parentCallActivityId?: string;
  businessKey?: string;
  status: 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  createdAt: Date;
  endedAt?: Date;
  startedBy?: string;
  startedByDetails?: UserDetails;
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
  /** Multi-instance: 0-based index of this iteration. */
  executionIndex?: number;
  /** Multi-instance: key to correlate iterations (nodeId-scopeId). */
  multiInstanceKey?: string;
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
  /** Multi-instance: tracks completion per MI activity. Key: nodeId-scopeId. */
  multiInstancePending?: Record<
    string,
    { nodeId: string; scopeId: string; parentTokenId: string; totalItems: number; completedCount: number }
  >;
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
  | 'DECISION_RECORDED'
  | 'MULTI_INSTANCE_RESOLVED';

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

export type OutboxKind = 'CALLBACK_WORK' | 'CALLBACK_DECISION' | 'CALLBACK_EVENT' | 'CALLBACK_MULTI_INSTANCE_RESOLVE';

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

export type TimerScheduleStatus = 'ACTIVE' | 'PAUSED' | 'EXHAUSTED';

export type TimerScheduleDoc = {
  _id: string;
  definitionId: string;
  nodeId: string;
  kind: 'cycle' | 'date' | 'duration' | 'cron' | 'rrule';
  expression: string;
  nextFireAt: Date;
  lastFiredAt?: Date;
  remainingReps: number | null;
  status: TimerScheduleStatus;
  ownerId?: string;
  leaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ConnectorScheduleStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

export type ConnectorScheduleDoc = {
  _id: string;
  definitionId: string;
  nodeId: string;
  connectorType: string;
  /** Connector-specific config from BPMN tri: extensions (e.g. mailbox address). */
  config: Record<string, string>;
  pollingIntervalMs: number;
  lastPolledAt?: Date;
  /** Dedup: last processed message ID or delta token. */
  cursor?: string;
  status: ConnectorScheduleStatus;
  ownerId?: string;
  leaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type NodeDef = {
  id: string;
  type: string;
  name?: string;
  laneRef?: string;
  /** tri:roleId from pool/lane; used for worklist filtering by user roleAssignments */
  roleId?: string;
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
      COLLECTION_NAMES.ProcessDefinition
    ),
    ProcessInstances: database.collection<ProcessInstanceDoc>(
      COLLECTION_NAMES.ProcessInstance
    ),
    ProcessInstanceState: database.collection<ProcessInstanceStateDoc>(
      COLLECTION_NAMES.ProcessInstanceState
    ),
    ProcessInstanceEvents: database.collection<ProcessInstanceEventDoc>(
      COLLECTION_NAMES.ProcessInstanceEvent
    ),
    Continuations: database.collection<ContinuationDoc>(
      COLLECTION_NAMES.Continuation
    ),
    Outbox: database.collection<OutboxDoc>(COLLECTION_NAMES.Outbox),
    HumanTasks: database.collection<HumanTaskDoc>(COLLECTION_NAMES.HumanTask),
    ProcessInstanceHistory: database.collection<ProcessInstanceHistoryDoc>(
      COLLECTION_NAMES.ProcessInstanceHistory
    ),
    TimerSchedules: database.collection<TimerScheduleDoc>(
      COLLECTION_NAMES.TimerSchedule
    ),
    ConnectorSchedules: database.collection<ConnectorScheduleDoc>(
      COLLECTION_NAMES.ConnectorSchedule
    ),
  };
}
