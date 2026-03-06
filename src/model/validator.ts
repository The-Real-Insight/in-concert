import { parseBpmnXml } from './parser';
import type { NormalizedGraph } from './types';

export type ValidationIssue = {
  rule: string;
  severity: 'error' | 'warning';
  elementId?: string;
  elementType?: string;
  message: string;
};

/** Parse lane elements from BPMN XML to extract id, name, tri:roleId. */
function parseLanesFromXml(xml: string): { id: string; name?: string; roleId?: string }[] {
  const result: { id: string; name?: string; roleId?: string }[] = [];
  const laneRe = /<bpmn:lane\s+id="([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = laneRe.exec(xml))) {
    const attrs = m[2] ?? '';
    const name = attrs.match(/name="([^"]*)"/)?.[1]?.trim();
    const roleId = attrs.match(/tri:roleId="([^"]*)"/)?.[1]?.trim();
    result.push({ id: m[1]!, name, roleId });
  }
  return result;
}

/** Parse participant (pool) elements from BPMN XML to extract id, name, tri:roleId. */
function parseParticipantsFromXml(xml: string): { id: string; name?: string; roleId?: string }[] {
  const result: { id: string; name?: string; roleId?: string }[] = [];
  const participantRe = /<bpmn:participant\s+id="([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = participantRe.exec(xml))) {
    const attrs = m[2] ?? '';
    const name = attrs.match(/name="([^"]*)"/)?.[1]?.trim();
    const roleId = attrs.match(/tri:roleId="([^"]*)"/)?.[1]?.trim();
    result.push({ id: m[1]!, name, roleId });
  }
  return result;
}

/** Check that pools and lanes have a name and non-empty tri:roleId. */
function validatePoolsAndLanes(xml: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const lanes = parseLanesFromXml(xml);
  for (const lane of lanes) {
    if (!lane.name || lane.name.length === 0) {
      issues.push({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        severity: 'error',
        elementId: lane.id,
        elementType: 'lane',
        message: `Lane "${lane.id}" must have a non-empty name`,
      });
    }
    if (!lane.roleId || lane.roleId.length === 0) {
      issues.push({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        severity: 'error',
        elementId: lane.id,
        elementType: 'lane',
        message: `Lane "${lane.id}" must have a non-empty tri:roleId attribute`,
      });
    }
  }

  const participants = parseParticipantsFromXml(xml);
  for (const pool of participants) {
    if (!pool.name || pool.name.length === 0) {
      issues.push({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        severity: 'error',
        elementId: pool.id,
        elementType: 'pool',
        message: `Pool "${pool.id}" must have a non-empty name`,
      });
    }
    if (!pool.roleId || pool.roleId.length === 0) {
      issues.push({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        severity: 'error',
        elementId: pool.id,
        elementType: 'pool',
        message: `Pool "${pool.id}" must have a non-empty tri:roleId attribute`,
      });
    }
  }

  return issues;
}

const TASK_LIKE_TYPES = new Set([
  'userTask',
  'serviceTask',
  'subProcess',
  'callActivity',
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
]);

/**
 * Check for orphaned flow nodes (no incoming or no outgoing connections).
 */
function validateNoOrphanedNodes(graph: NormalizedGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { nodes, metadata } = graph;
  const incoming = metadata.incomingByNode ?? {};
  const outgoing = metadata.outgoingByNode ?? {};

  for (const [nodeId, node] of Object.entries(nodes)) {
    const inCount = (incoming[nodeId] ?? []).length;
    const outCount = (outgoing[nodeId] ?? []).length;

    switch (node.type) {
      case 'startEvent':
        if (outCount === 0) {
          issues.push({
            rule: 'NO_ORPHANED_NODES',
            severity: 'error',
            elementId: nodeId,
            elementType: 'startEvent',
            message: `Start event "${nodeId}" has no outgoing flow`,
          });
        }
        break;
      case 'endEvent':
        if (inCount === 0) {
          issues.push({
            rule: 'NO_ORPHANED_NODES',
            severity: 'error',
            elementId: nodeId,
            elementType: 'endEvent',
            message: `End event "${nodeId}" has no incoming flow`,
          });
        }
        break;
      default:
        if (TASK_LIKE_TYPES.has(node.type)) {
          if (inCount === 0) {
            issues.push({
              rule: 'NO_ORPHANED_NODES',
              severity: 'error',
              elementId: nodeId,
              elementType: node.type,
              message: `"${node.name || nodeId}" has no incoming flow`,
            });
          }
          if (outCount === 0) {
            issues.push({
              rule: 'NO_ORPHANED_NODES',
              severity: 'error',
              elementId: nodeId,
              elementType: node.type,
              message: `"${node.name || nodeId}" has no outgoing flow`,
            });
          }
        }
        break;
    }
  }

  return issues;
}

/**
 * Validate a BPMN model for executability and consistency.
 * Returns a list of problematic model elements.
 */
export function validateBpmnGraph(graph: NormalizedGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (graph.startNodeIds.length === 0) {
    issues.push({
      rule: 'AT_LEAST_ONE_START',
      severity: 'error',
      message: 'Process must have at least one start event',
    });
  }

  issues.push(...validateNoOrphanedNodes(graph));

  return issues;
}

/**
 * Validate BPMN XML for executability and consistency.
 * Parses the XML and runs all validation rules including pool/lane rules.
 */
export async function validateBpmnXml(xml: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  let graph: NormalizedGraph;
  try {
    graph = await parseBpmnXml(xml);
  } catch (err) {
    return [
      {
        rule: 'PARSE_ERROR',
        severity: 'error',
        message: err instanceof Error ? err.message : 'Failed to parse BPMN XML',
      },
    ];
  }

  issues.push(...validateBpmnGraph(graph));
  issues.push(...validatePoolsAndLanes(xml));

  return issues;
}
