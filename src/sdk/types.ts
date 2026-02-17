/**
 * SDK types - shared between REST and local modes
 */

export type DeployParams = {
  name: string;
  version: number;
  bpmnXml: string;
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
};

export type StartInstanceResult = {
  instanceId: string;
  status: string;
};

export type InstanceSummary = {
  _id: string;
  status: 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  createdAt: Date;
  endedAt?: Date;
};

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
};

export type CallbackDecisionPayload = Record<string, unknown>;

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
