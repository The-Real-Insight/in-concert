/**
 * SDK types - shared between REST and local modes
 */

export type User = {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  photoUrl?: string;
};

export type DeployParams = {
  /** Business id (e.g. AgenticWorkflow._id). Unique per (id, version). */
  id: string;
  name: string;
  /** Version as string (e.g. "1", "1.1", "2.0"). */
  version: string;
  bpmnXml: string;
  /** If true and (id, version) exists, update the definition. Default: false. */
  overwrite?: boolean;
  tenantId?: string;
};

export type DeployResult = {
  definitionId: string;
};

export type StartInstanceParams = {
  commandId: string;
  definitionId: string;
  businessKey?: string;
  tenantId?: string;
  /** When provided, startedBy = user.email and startedByDetails = user on ProcessInstance */
  user?: User;
  /** Conversation _id for document/data management (outside engine) */
  conversationId?: string;
};

export type StartInstanceResult = {
  instanceId: string;
  status: string;
};

export type InstanceSummary = {
  _id: string;
  conversationId?: string;
  status: 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  createdAt: Date;
  endedAt?: Date;
  startedBy?: string;
  startedByDetails?: User;
};

/** Audit trail entry for a process instance. */
export type ProcessHistoryEntry = {
  instanceId: string;
  seq: number;
  eventType: 'INSTANCE_STARTED' | 'TASK_STARTED' | 'TASK_COMPLETED';
  at: Date;
  startedBy?: string;
  startedByDetails?: User;
  nodeId?: string;
  nodeName?: string;
  nodeType?: 'userTask' | 'serviceTask';
  workItemId?: string;
  scopeId?: string;
  completedBy?: string;
  completedByDetails?: User;
  result?: unknown;
  createdAt: Date;
  _id?: string;
};

export type ListTasksParams = {
  instanceId?: string;
  status?: string;
  assigneeUserId?: string;
  /** User _id for worklist-for-user filter (claimed tasks) */
  userId?: string;
  /** Role IDs from user.roleAssignments[].role (ObjectId as string) for OPEN task filtering */
  roleIds?: string[];
  limit?: number;
  sortOrder?: 'asc' | 'desc'; // createdAt: asc = oldest first (process order), desc = newest first
};

export type WorklistTask = import('../db/collections').HumanTaskDoc;

export type WorkItemRef = {
  workItemId: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  kind: 'SERVICE_TASK' | 'USER_TASK' | 'CALL_ACTIVITY';
  status: string;
  createdAt: Date;
};

export type PendingDecisionRef = {
  decisionId: string;
  kind: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  optionsHash: string;
  createdAt: Date;
};

export type CallbackWorkPayload = {
  workItemId: string;
  instanceId: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  kind: 'serviceTask' | 'userTask';
  name?: string;
  lane?: string; // BPMN lane name (role)
  /** tri:roleId from pool/lane; used for worklist filtering by user roleAssignments */
  roleId?: string;
  /** Custom extension attributes from BPMN node (e.g. tri:toolId, tri:toolType). */
  extensions?: Record<string, string>;
};

/** Transition option for XOR gateway—one outgoing alternative. */
export type DecisionTransition = {
  flowId: string;
  name?: string;
  conditionExpression?: string;
  isDefault: boolean;
  toNodeId?: string;
  targetNodeName?: string;
  targetNodeType?: string;
};

/** XOR gateway decision payload. Structured for LLM use with direct access to model strings. */
export type CallbackDecisionPayload = {
  type: 'DECISION_REQUIRED';
  decisionId: string;
  instanceId: string;
  nodeId: string;
  /** Gateway element metadata (the decision point). */
  gateway: { id: string; name?: string; type: string };
  /** Outgoing transitions—alternatives with names, conditions, and target tasks. */
  transitions: DecisionTransition[];
  /** Legacy shape; prefer transitions for new code. */
  evaluation?: {
    kind: string;
    outgoing: Array<{
      flowId: string;
      toNodeId?: string;
      isDefault: boolean;
      name?: string;
      conditionExpression?: string;
      targetNodeName?: string;
    }>;
  };
};

/**
 * Registered handlers for event-driven processing.
 * Callbacks receive state changes (work items, decisions) and react—no polling.
 */
export type CallbackHandlers = {
  /** Called for user tasks. Skip for worklist flow; otherwise complete via completeUserTask(). */
  onWorkItem?: (item: {
    kind: 'CALLBACK_WORK';
    instanceId: string;
    payload: CallbackWorkPayload;
  }) => void | Promise<void>;
  /** Called for service tasks. Invoke service, then completeExternalTask(). */
  onServiceCall?: (item: {
    kind: 'CALLBACK_WORK';
    instanceId: string;
    payload: CallbackWorkPayload;
  }) => void | Promise<void>;
  /** Called for XOR gateway decisions. Choose flow, then submitDecision(). */
  onDecision?: (item: {
    kind: 'CALLBACK_DECISION';
    instanceId: string;
    payload: CallbackDecisionPayload;
  }) => void | Promise<void>;
};

/**
 * Engine init config. Register once at server start.
 * Defines how to process interruptions (work items, decisions) and optional service vocabulary.
 */
export type EngineInitConfig = {
  onWorkItem?: CallbackHandlers['onWorkItem'];
  onServiceCall?: CallbackHandlers['onServiceCall'];
  onDecision?: CallbackHandlers['onDecision'];
  /** Service/tool registry (e.g. tri:toolId → implementation). Handlers use this to resolve and invoke. */
  serviceVocabulary?: Record<string, unknown>;
};

export type CallbackItem =
  | { kind: 'CALLBACK_WORK'; instanceId: string; payload: CallbackWorkPayload }
  | { kind: 'CALLBACK_DECISION'; instanceId: string; payload: CallbackDecisionPayload };

export type InstanceState = {
  _id: string;
  version: number;
  status: 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  tokens: Array<{ tokenId: string; nodeId: string; scopeId: string; status: string }>;
  scopes: Array<{ scopeId: string; kind: string }>;
  waits: {
    workItems: WorkItemRef[];
    messageSubs: unknown[];
    timers: unknown[];
    decisions: PendingDecisionRef[];
  };
};
