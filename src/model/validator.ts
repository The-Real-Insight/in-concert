import { parseBpmnXml } from './parser';
import type { NormalizedGraph } from './types';

export type ValidationIssue = {
  rule: string;
  severity: 'error' | 'warning';
  /** Single element (legacy). Prefer elementIds when an issue concerns multiple elements. */
  elementId?: string;
  /** All elements concerned by this issue. Use when one rule applies to multiple elements. */
  elementIds?: string[];
  elementType?: string;
  message: string;
};

/** Aggregated role from BPMN (lane or pool with the engine's roleId attribute). */
export type BpmnRole = { roleId: string; roleName?: string };

/**
 * Read an engine-interpreted attribute accepting either the canonical
 * `in-concert:` namespace or the legacy `tri:` namespace. `in-concert:`
 * wins when both are present on the same element. Mirrors the helper
 * used by the parser — kept local here to keep the validator usable
 * without circular imports.
 */
function readEngineAttr(attrs: string, name: string): string | null {
  const modern = new RegExp(`\\bin-concert:${name}="([^"]*)"`, 'i').exec(attrs);
  if (modern) return modern[1]!;
  const legacy = new RegExp(`\\btri:${name}="([^"]*)"`, 'i').exec(attrs);
  return legacy ? legacy[1]! : null;
}

/** Parse lane elements. Accepts `in-concert:roleId` (canonical) or `tri:roleId` (legacy). */
function parseLanesFromXml(xml: string): { id: string; name?: string; roleId?: string }[] {
  const result: { id: string; name?: string; roleId?: string }[] = [];
  const laneRe = /<bpmn:lane\s+id="([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = laneRe.exec(xml))) {
    const attrs = m[2] ?? '';
    const name = attrs.match(/name="([^"]*)"/)?.[1]?.trim();
    const roleId = readEngineAttr(attrs, 'roleId')?.trim();
    result.push({ id: m[1]!, name, roleId });
  }
  return result;
}

/** Parse participant (pool) elements. Accepts `in-concert:roleId` (canonical) or `tri:roleId` (legacy). */
function parseParticipantsFromXml(xml: string): { id: string; name?: string; roleId?: string }[] {
  const result: { id: string; name?: string; roleId?: string }[] = [];
  const participantRe = /<bpmn:participant\s+id="([^"]+)"([^>]*)>/gi;
  let m;
  while ((m = participantRe.exec(xml))) {
    const attrs = m[2] ?? '';
    const name = attrs.match(/name="([^"]*)"/)?.[1]?.trim();
    const roleId = readEngineAttr(attrs, 'roleId')?.trim();
    result.push({ id: m[1]!, name, roleId });
  }
  return result;
}

/** Check that pools and lanes have a name and a non-empty engine roleId attribute. */
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
        message: `Lane "${lane.id}" must have a non-empty in-concert:roleId (or legacy tri:roleId) attribute`,
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
        message: `Pool "${pool.id}" must have a non-empty in-concert:roleId (or legacy tri:roleId) attribute`,
      });
    }
  }

  return issues;
}

/**
 * Extract all roles (tri:roleId) from BPMN XML, from lanes and participants.
 * Deduplicated by roleId. Used for synthetic role assignments in test portals.
 */
export function extractRolesFromBpmn(xml: string): BpmnRole[] {
  const seen = new Set<string>();
  const result: BpmnRole[] = [];
  const lanes = parseLanesFromXml(xml);
  for (const l of lanes) {
    if (l.roleId && !seen.has(l.roleId)) {
      seen.add(l.roleId);
      result.push({ roleId: l.roleId, roleName: l.name ?? l.id });
    }
  }
  const participants = parseParticipantsFromXml(xml);
  for (const p of participants) {
    if (p.roleId && !seen.has(p.roleId)) {
      seen.add(p.roleId);
      result.push({ roleId: p.roleId, roleName: p.name ?? p.id });
    }
  }
  return result;
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
