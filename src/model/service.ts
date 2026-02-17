import { v4 as uuidv4 } from 'uuid';
import { parseBpmnXml } from './parser';
import type { NormalizedGraph } from './types';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';

export type DeployResult = {
  definitionId: string;
};

export async function deployDefinition(
  db: Db,
  params: { name: string; version: number; bpmnXml: string; tenantId?: string }
): Promise<DeployResult> {
  const { ProcessDefinitions } = getCollections(db);

  const graph = await parseBpmnXml(params.bpmnXml);

  if (graph.startNodeIds.length === 0) {
    throw new Error('Process must have at least one start event');
  }

  const definitionId = uuidv4();
  const now = new Date();

  await ProcessDefinitions.insertOne({
    _id: definitionId,
    tenantId: params.tenantId,
    name: params.name,
    version: params.version,
    bpmnXml: params.bpmnXml,
    graph,
    createdAt: now,
  });

  return { definitionId };
}

export async function getDefinition(
  db: Db,
  definitionId: string
): Promise<{ _id: string; graph: NormalizedGraph } | null> {
  const { ProcessDefinitions } = getCollections(db);
  const doc = await ProcessDefinitions.findOne(
    { _id: definitionId },
    { projection: { _id: 1, graph: 1 } }
  );
  return doc as { _id: string; graph: NormalizedGraph } | null;
}
