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

/** Options for activateSchedules — persisted on timer/connector schedule docs for this definition. */
export type ActivateSchedulesOptions = {
  graphCredentials?: { tenantId: string; clientId: string; clientSecret: string };
  /**
   * Portal/customer tenant that is activating (starting) these schedules.
   * Stored as `startingTenantId` on ConnectorSchedule and TimerSchedule; instances started by
   * email/timer get `ProcessInstances.tenantId` from this (not from the process definition).
   */
  startingTenantId?: string;
  /**
   * Per-tenant overrides merged into every non-timer `TriggerSchedule.config`
   * for this definition. Keys are written as dotted `config.<key>` via `$set`,
   * so BPMN-authored defaults for attrs the tenant didn't specify stay intact
   * and only named fields are replaced. Empty / null values are skipped so a
   * tenant-left-blank field doesn't wipe out the author's default.
   *
   * Typical use: the portal stores per-procurement values (mailbox for a
   * graph-mailbox workflow, siteUrl/driveName/folderPath for sharepoint-folder)
   * and the host forwards them here at activate time.
   */
  configOverrides?: Record<string, string>;
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
  /** tri:multiInstanceData from BPMN node; reference for per-iteration data. */
  multiInstanceData?: string;
  /** tri:parameterOverwrites from BPMN node; JSON string for parameter overrides. */
  parameterOverwrites?: string;
  /** Multi-instance: 0-based index of this iteration. */
  executionIndex?: number;
  /** Multi-instance: 1-based loop counter (BPMN style). */
  loopCounter?: number;
  /** Multi-instance: total number of iterations. */
  totalItems?: number;
};

/** Payload for multi-instance resolve callback. Handler returns { items: unknown[] }. */
export type CallbackMultiInstanceResolvePayload = {
  instanceId: string;
  nodeId: string;
  tokenId: string;
  scopeId: string;
  kind: 'serviceTask' | 'userTask';
  name?: string;
  lane?: string;
  roleId?: string;
  /** Custom extension attributes including tri:multiInstanceData. */
  extensions?: Record<string, string>;
  /** tri:multiInstanceData from BPMN node; reference for per-iteration data. */
  multiInstanceData?: string;
  /** tri:parameterOverwrites from BPMN node; JSON string for parameter overrides. */
  parameterOverwrites?: string;
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
  /**
   * Extension attributes authored on the `<bpmn:sequenceFlow>` under any
   * non-reserved namespace, keyed fully qualified (e.g. `acme:condition1`,
   * `myco:weight`). The engine does not interpret these — your handler
   * reads them and decides what they mean. Absent when the flow carries
   * no extension attributes.
   */
  attrs?: Record<string, string>;
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
  /** Called for multi-instance tasks. Return { items: unknown[] }, then call submitMultiInstanceData(). */
  onMultiInstanceResolve?: (item: {
    kind: 'CALLBACK_MULTI_INSTANCE_RESOLVE';
    instanceId: string;
    payload: CallbackMultiInstanceResolvePayload;
  }) => Promise<{ items: unknown[] }>;
};

/**
 * Engine init config. Register once at server start.
 * Defines how to process interruptions (work items, decisions) and optional service vocabulary.
 */
export type GraphConnectorConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Default polling interval for graph-mailbox connectors (ms). Default: 10000. */
  pollingIntervalMs?: number;
  /** Only fetch emails received within this many minutes. Default: 1440 (24h). */
  sinceMinutes?: number;
};

export type MailAttachment = {
  id: string;
  name: string;
  contentType: string;
  /** Size in bytes. */
  size: number;
};

export type MailReceivedEvent = {
  mailbox: string;
  instanceId: string;
  definitionId: string;
  email: {
    id: string;
    subject: string;
    from: { name?: string; address: string };
    toRecipients: Array<{ name?: string; address: string }>;
    receivedDateTime: string;
    bodyPreview: string;
    body: { contentType: string; content: string };
    hasAttachments: boolean;
    /** Attachment metadata (name, size, contentType). Content is NOT pre-loaded. */
    attachments: MailAttachment[];
  };
  /**
   * Download a single attachment's content on demand.
   * Returns a Buffer — only loads the attachment you ask for.
   * Use attachment.size to decide whether to download (e.g. skip files > 50 MB).
   */
  getAttachmentContent: (attachmentId: string) => Promise<Buffer>;
};

export type MailReceivedResult = {
  /** Set to true to cancel the instance (e.g. spam, duplicate, wrong mailbox). */
  skip?: boolean;
} | void;

export type EngineInitConfig = {
  onWorkItem?: CallbackHandlers['onWorkItem'];
  onServiceCall?: CallbackHandlers['onServiceCall'];
  onDecision?: CallbackHandlers['onDecision'];
  onMultiInstanceResolve?: CallbackHandlers['onMultiInstanceResolve'];
  /**
   * Called when the graph-mailbox connector receives an email.
   * The instance is already created (you have instanceId) but no token has advanced yet.
   * Store domain data, fetch attachments, create conversations — then return.
   * Return { skip: true } to terminate the instance without running the process.
   */
  onMailReceived?: (event: MailReceivedEvent) => Promise<MailReceivedResult>;
  /** Service/tool registry (e.g. tri:toolId → implementation). Handlers use this to resolve and invoke. */
  serviceVocabulary?: Record<string, unknown>;
  /** Connector credentials. Overrides environment variables when provided. */
  connectors?: {
    'graph-mailbox'?: GraphConnectorConfig;
  };
};

export type CallbackItem =
  | { kind: 'CALLBACK_WORK'; instanceId: string; payload: CallbackWorkPayload }
  | { kind: 'CALLBACK_DECISION'; instanceId: string; payload: CallbackDecisionPayload }
  | { kind: 'CALLBACK_MULTI_INSTANCE_RESOLVE'; instanceId: string; payload: CallbackMultiInstanceResolvePayload };

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
