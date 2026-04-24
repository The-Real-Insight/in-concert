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
  TriggerSchedule: 'TriggerSchedule',
  TriggerFireEvent: 'TriggerFireEvent',
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
  /**
   * Deduplication key for starts that may retry (trigger fires, idempotent
   * API requests). Together with `definitionId`, this is the exactly-once
   * guarantee: two `startInstance` calls with the same (definitionId,
   * idempotencyKey) collapse to a single process instance. Enforced via a
   * partial unique index.
   */
  idempotencyKey?: string;
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
  /** Portal/customer tenant that activated this schedule (process instances started by timer inherit this). */
  startingTenantId?: string;
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
  /** Portal/customer tenant that activated this schedule (process instances started by connector inherit this). */
  startingTenantId?: string;
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

/**
 * Unified schedule row for the generalized start-trigger mechanism. Replaces
 * TimerScheduleDoc and ConnectorScheduleDoc — the refactor migrates both
 * into this shape. Old collections are retained during the transition and
 * dropped in a follow-up PR once the migration has been validated.
 */
export type TriggerScheduleStatus = 'ACTIVE' | 'PAUSED' | 'EXHAUSTED' | 'DISABLED';

export type TriggerScheduleDoc = {
  _id: string;
  /** Stable id used in REST paths. Survives restarts; typically equals _id but
   *  kept separate so we can rename _id if we ever switch id strategies. */
  scheduleId: string;
  definitionId: string;
  /** Portal/customer tenant that activated this schedule (process instances inherit this). */
  startingTenantId?: string;
  /** The BPMN start-event node this schedule is bound to. */
  startEventId: string;
  /** Discriminator matched to a registered StartTrigger. */
  triggerType: string;
  /** Flattened tri:* attributes + standard BPMN attrs; the trigger interprets this. */
  config: Record<string, unknown>;
  /** Opaque trigger-owned cursor. Engine never inspects. */
  cursor: string | null;
  /** Per-schedule credential override, or null to fall back to the trigger's defaults. */
  credentials: Record<string, unknown> | null;
  /** First-poll behavior: fire existing items on initial deploy, or skip them. */
  initialPolicy: 'fire-existing' | 'skip-existing';
  status: TriggerScheduleStatus;
  /** For fire-at triggers (timer); absent for interval triggers. */
  nextFireAt?: Date;
  /** For interval triggers (mailbox, sharepoint); absent for fire-at triggers. */
  intervalMs?: number;
  lastFiredAt?: Date;
  /** Last failure message, for observability. Cleared on next successful fire. */
  lastError?: string;
  /** Fire counter — useful for bounded-repetition triggers (RRULE COUNT, repeating timers). */
  remainingReps?: number | null;
  ownerId?: string;
  leaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * One row per trigger fire that actually did something (created an instance
 * or failed). "No-op" fires — cycles where the plugin observed nothing or
 * filtered everything out — are NOT written; the schedule's `lastFiredAt`
 * carries the heartbeat instead. Keeps the table sized to interesting
 * activity, not activity period.
 *
 * Write path: the scheduler constructs one of these inside `fireClaimedSchedule`
 * after the plugin returns, using counters accumulated via the `FireReporter`
 * attached to the invocation. Written outside the fire's Mongo transaction —
 * this is telemetry, not business data.
 */
export type TriggerFireOutcome = 'ok' | 'error' | 'no-op';

export type TriggerFireErrorStage =
  | 'resolveSite'       // site/drive lookup (or equivalent source-resolution step) failed
  | 'delta'             // listing/polling upstream source failed (delta, Graph, MCP tool, …)
  | 'fire'              // plugin `fire()` threw synchronously or rejected
  | 'callback'          // host callback (onMailReceived, onFileReceived, evaluate, …) threw
  | 'unknown';

export type TriggerFireEventDoc = {
  _id: string;
  scheduleId: string;
  definitionId: string;
  triggerType: string;
  firedAt: Date;
  durationMs: number;
  outcome: TriggerFireOutcome;
  /** Raw items the plugin inspected (delta entries, emails, tool observations, …). */
  itemsObserved: number;
  /** Items that became process instances. */
  itemsFired: number;
  /** Items dropped by the plugin (filtered, already-processed, callback rejected). */
  itemsSkipped: number;
  /** Per-reason counts — plugin owns the string keys. Typical examples:
   *  `filter-pattern`, `non-recursive-scope`, `partial-upload`, `already-processed`,
   *  `callback-skip`, `callback-error`. */
  dropReasons: Record<string, number>;
  /** Process instances this fire created. */
  instanceIds: string[];
  error?: {
    stage: TriggerFireErrorStage;
    message: string;
    httpStatus?: number;
    /** Plugin-populated when upstream returns a structured error code (e.g. Graph). */
    upstreamCode?: string;
    /** First ~500 chars of the raw error body / stack. */
    rawSnippet?: string;
  };
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
    // writeConcern: 'majority' is load-bearing for the claim race.
    // `claimContinuation` uses `readConcern: 'majority'` to read a
    // majority-committed snapshot; that only works if the matching write
    // was also majority-committed before returning. Without it, `startInstance`
    // (and other continuation writers) can return before the insert has
    // propagated, and a subsequent `run(instanceId) → awaitQuiescent →
    // claimContinuation` can miss the START continuation, treat the instance
    // as quiescent, and resolve the waiter before any work has been
    // dispatched. Pinning majority here closes the window at the source.
    Continuations: database.collection<ContinuationDoc>(
      COLLECTION_NAMES.Continuation,
      { writeConcern: { w: 'majority' } }
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
    TriggerSchedules: database.collection<TriggerScheduleDoc>(
      COLLECTION_NAMES.TriggerSchedule
    ),
    TriggerFireEvents: database.collection<TriggerFireEventDoc>(
      COLLECTION_NAMES.TriggerFireEvent
    ),
  };
}
