/**
 * Supported tri: extension attributes for BPMN (http://tri.com/schema/bpmn).
 * All attributes are parsed into node.extensions and passed to callbacks.
 */
export const TRI_EXTENSION_ATTRIBUTES = [
  /** Tool identifier for service tasks. */
  'tri:toolId',
  /** Tool type (e.g. promptTool, mailTool). */
  'tri:toolType',
  /** Reference for multi-instance collection (e.g. processList, ${items}). */
  'tri:multiInstanceData',
  /** Data pool item name this task produces (e.g. Themenliste for downstream multi-instance). */
  'tri:outputData',
  /** JSON string for parameter overrides. */
  'tri:parameterOverwrites',
] as const;

export type TriExtensionAttribute = (typeof TRI_EXTENSION_ATTRIBUTES)[number];
