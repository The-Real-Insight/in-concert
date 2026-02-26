import { v4 as uuidv4 } from 'uuid';
import { parseBpmnXml } from './parser';
import type { NormalizedGraph } from './types';
import type { Db } from 'mongodb';
import { getCollections } from '../db/collections';

export type DeployResult = {
  definitionId: string;
};

export type DeployParams = {
  id: string;
  name: string;
  version: string;
  bpmnXml: string;
  overwrite?: boolean;
  tenantId?: string;
};

export async function deployDefinition(
  db: Db,
  params: DeployParams
): Promise<DeployResult> {
  const { ProcessDefinitions } = getCollections(db);

  const graph = await parseBpmnXml(params.bpmnXml);

  if (graph.startNodeIds.length === 0) {
    throw new Error('Process must have at least one start event');
  }

  const now = new Date();
  const existing = await ProcessDefinitions.findOne(
    { id: params.id, version: params.version },
    { projection: { _id: 1 } }
  );

  if (existing) {
    if (params.overwrite !== true) {
      throw new Error(
        `Process definition already exists for id="${params.id}" version="${params.version}". Set overwrite=true to replace.`
      );
    }
    await ProcessDefinitions.updateOne(
      { _id: existing._id },
      {
        $set: {
          name: params.name,
          bpmnXml: params.bpmnXml,
          graph,
          deployedAt: now,
        },
      }
    );
    return { definitionId: existing._id };
  }

  const definitionId = uuidv4();
  await ProcessDefinitions.insertOne({
    _id: definitionId,
    id: params.id,
    tenantId: params.tenantId,
    name: params.name,
    version: params.version,
    bpmnXml: params.bpmnXml,
    graph,
    createdAt: now,
    deployedAt: now,
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

export async function getDefinitionByIdAndVersion(
  db: Db,
  id: string,
  version?: string
): Promise<{ _id: string; graph: NormalizedGraph } | null> {
  const { ProcessDefinitions } = getCollections(db);
  if (version != null && version !== '') {
    const doc = await ProcessDefinitions.findOne(
      { id, version },
      { projection: { _id: 1, graph: 1 } }
    );
    return doc as { _id: string; graph: NormalizedGraph } | null;
  }
  const doc = await ProcessDefinitions.findOne(
    { id },
    { sort: { deployedAt: -1 }, projection: { _id: 1, graph: 1 } }
  );
  return doc as { _id: string; graph: NormalizedGraph } | null;
}
