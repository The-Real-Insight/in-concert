/**
 * tri-bpmn-engine SDK
 *
 * import { BpmnEngineClient } from 'tri-bpmn-engine/sdk';
 *
 * // REST mode - talk to running server
 * const client = new BpmnEngineClient({
 *   mode: 'rest',
 *   baseUrl: 'http://localhost:3000',
 * });
 *
 * // Local mode - direct DB access, no server
 * import { connectDb, ensureIndexes } from 'tri-bpmn-engine/db';
 * const db = await connectDb();
 * await ensureIndexes(db);
 * const client = new BpmnEngineClient({ mode: 'local', db });
 */
export { BpmnEngineClient } from './client';
export { TriSdk } from './facade';
export type {
  TriSdkConfig,
  TriSdkEngineConfig,
  TaskListParams,
  TaskListResult,
} from './facade';
export type { SdkConfig, SdkConfigRest, SdkConfigLocal } from './client';
export type {
  CallbackHandlers,
  DeployParams,
  DeployResult,
  StartInstanceParams,
  StartInstanceResult,
  InstanceSummary,
  InstanceState,
  WorkItemRef,
  PendingDecisionRef,
  CallbackItem,
  CallbackWorkPayload,
  CallbackDecisionPayload,
} from './types';
