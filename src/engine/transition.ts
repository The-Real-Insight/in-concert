import { v4 as uuidv4 } from 'uuid';
import type {
  ProcessInstanceStateDoc,
  ContinuationDoc,
  Token,
  Scope,
  ProcessInstanceEventDoc,
  ContinuationDoc as ContinuationDocType,
  OutboxDoc,
} from '../db/collections';
import type { NormalizedGraph, NodeDef, FlowDef } from '../model/types';

export type TransitionResult = {
  events: ProcessInstanceEventDoc[];
  statePatch: Partial<ProcessInstanceStateDoc>;
  newContinuations: Omit<ContinuationDocType, '_id'>[];
  outbox: Omit<OutboxDoc, '_id'>[];
};

function getOutgoingFlows(graph: NormalizedGraph, nodeId: string): FlowDef[] {
  const flowIds = graph.metadata.outgoingByNode[nodeId] ?? [];
  return flowIds.map((id) => graph.flows[id]).filter(Boolean);
}

function getTargetNode(graph: NormalizedGraph, flowId: string): string | undefined {
  return graph.flows[flowId]?.targetRef;
}

function getIncomingFlows(graph: NormalizedGraph, nodeId: string): FlowDef[] {
  const flowIds = graph.metadata.incomingByNode[nodeId] ?? [];
  return flowIds.map((id) => graph.flows[id]).filter(Boolean);
}

function createTokenAtNodeCont(
  instanceId: string,
  tokenId: string,
  nodeId: string,
  scopeId: string,
  flowId: string | undefined,
  now: Date
) {
  return {
    instanceId,
    dueAt: now,
    kind: 'TOKEN_AT_NODE' as const,
    payload: { tokenId, nodeId, scopeId, ...(flowId && { incomingFlowId: flowId }) },
    status: 'READY' as const,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyTransition(
  state: ProcessInstanceStateDoc,
  continuation: ContinuationDoc,
  graph: NormalizedGraph,
  now: Date
): TransitionResult {
  const events: ProcessInstanceEventDoc[] = [];
  const statePatch: Partial<ProcessInstanceStateDoc> = {};
  const newContinuations: Omit<ContinuationDocType, '_id'>[] = [];
  const outbox: Omit<OutboxDoc, '_id'>[] = [];
  let lastSeq = state.lastEventSeq;

  const emit = (type: string, payload: Record<string, unknown>) => {
    lastSeq++;
    events.push({
      instanceId: state._id,
      seq: lastSeq,
      type,
      at: now,
      payload,
    });
  };

  const tokens = [...state.tokens];
  const scopes = [...state.scopes];
  const waits = { ...state.waits };
  const joinArrivals = { ...(state.joinArrivals ?? {}) };

  const patchTokens = (fn: (tokens: Token[]) => Token[]) => {
    statePatch.tokens = fn(tokens);
  };
  const patchScopes = (fn: (scopes: Scope[]) => Scope[]) => {
    statePatch.scopes = fn(scopes);
  };

  const rootScope = scopes.find((s) => s.kind === 'ROOT');
  const rootScopeId = rootScope?.scopeId;

  if (continuation.kind === 'START') {
    if (tokens.length > 0) {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }

    const scopeId = uuidv4();
    emit('INSTANCE_CREATED', { instanceId: state._id });
    emit('SCOPE_CREATED', { scopeId, kind: 'ROOT' });
    patchScopes(() => [...scopes, { scopeId, kind: 'ROOT' }]);

    for (const startNodeId of graph.startNodeIds) {
      const tokenId = uuidv4();
      emit('TOKEN_CREATED', { tokenId, nodeId: startNodeId, scopeId, status: 'ACTIVE' });
      patchTokens((t) => [
        ...t,
        { tokenId, nodeId: startNodeId, scopeId, status: 'ACTIVE', createdAt: now },
      ]);
      newContinuations.push({
        instanceId: state._id,
        dueAt: now,
        kind: 'TOKEN_AT_NODE',
        payload: { tokenId, nodeId: startNodeId, scopeId },
        status: 'READY',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    statePatch.version = state.version + 1;
    statePatch.lastEventSeq = lastSeq;
    statePatch.updatedAt = now;
    return { events, statePatch, newContinuations, outbox };
  }

  if (continuation.kind === 'TOKEN_AT_NODE') {
    const { tokenId, nodeId, scopeId } = continuation.payload as {
      tokenId: string;
      nodeId: string;
      scopeId: string;
    };
    const token = tokens.find((t) => t.tokenId === tokenId);
    if (!token || token.status !== 'ACTIVE') {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }

    const node = graph.nodes[nodeId];
    if (!node) {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }

    emit('NODE_ENTERED', { nodeId, tokenId });

    if (node.type === 'startEvent') {
      const outgoingFlows = getOutgoingFlows(graph, nodeId);
      const idx = tokens.findIndex((t) => t.tokenId === tokenId);
      if (idx >= 0) {
        tokens[idx] = { ...tokens[idx], status: 'CONSUMED' };
      }
      emit('TOKEN_CONSUMED', { tokenId });

      for (const flow of outgoingFlows) {
        const toNodeId = getTargetNode(graph, flow.id);
        if (toNodeId) {
          const newTokenId = uuidv4();
          emit('TOKEN_CREATED', { tokenId: newTokenId, nodeId: toNodeId, scopeId, status: 'ACTIVE' });
          tokens.push({
            tokenId: newTokenId,
            nodeId: toNodeId,
            scopeId,
            status: 'ACTIVE',
            createdAt: now,
          });
          newContinuations.push(
            createTokenAtNodeCont(state._id, newTokenId, toNodeId, scopeId, flow.id, now)
          );
        }
      }
      patchTokens(() => [...tokens]);
    } else if (node.type === 'endEvent') {
      const idx = tokens.findIndex((t) => t.tokenId === tokenId);
      if (idx >= 0) {
        tokens[idx] = { ...tokens[idx], status: 'CONSUMED' };
        patchTokens(() => tokens);
      }
      emit('TOKEN_CONSUMED', { tokenId });

      const activeOrWaiting = tokens.filter(
        (t) => t.tokenId !== tokenId && (t.status === 'ACTIVE' || t.status === 'WAITING')
      );
      if (activeOrWaiting.length === 0) {
        emit('INSTANCE_COMPLETED', { instanceId: state._id });
        statePatch.status = 'COMPLETED';
      }
    } else if (node.type === 'serviceTask' || node.type === 'userTask') {
      const workItemId = uuidv4();
      const idx = tokens.findIndex((t) => t.tokenId === tokenId);
      if (idx >= 0) {
        tokens[idx] = { ...tokens[idx], status: 'WAITING' };
        patchTokens(() => tokens);
      }

      waits.workItems = [
        ...waits.workItems,
        {
          workItemId,
          nodeId,
          tokenId,
          scopeId,
          kind: node.type === 'serviceTask' ? 'SERVICE_TASK' : 'USER_TASK',
          status: 'OPEN',
          createdAt: now,
        },
      ];
      statePatch.waits = waits;

      emit('WORK_ITEM_CREATED', { workItemId, nodeId, tokenId, scopeId });

      outbox.push({
        instanceId: state._id,
        rootInstanceId: state._id,
        kind: 'CALLBACK_WORK',
        destination: { url: '' },
        payload: {
          workItemId,
          nodeId,
          tokenId,
          scopeId,
          kind: node.type,
          ...(node.name != null && { name: node.name }),
          ...(node.laneRef != null && { lane: node.laneRef }),
          ...(node.extensions && Object.keys(node.extensions).length > 0 && { extensions: node.extensions }),
        },
        status: 'READY',
        attempts: 0,
        nextAttemptAt: now,
        idempotencyKey: workItemId,
        createdAt: now,
        updatedAt: now,
      } as Omit<OutboxDoc, '_id'>);
    } else if (node.type === 'exclusiveGateway') {
      const outgoing = getOutgoingFlows(graph, nodeId);
      const incoming = getIncomingFlows(graph, nodeId);
      const isSplit = outgoing.length > 1;
      if (isSplit) {
        const decisionId = uuidv4();
        const optionsHash = outgoing.map((f) => f.id).sort().join('|');
        const idx = tokens.findIndex((t) => t.tokenId === tokenId);
        if (idx >= 0) tokens[idx] = { ...tokens[idx], status: 'WAITING' };
        patchTokens(() => tokens);
        waits.decisions = [
          ...waits.decisions,
          {
            decisionId,
            kind: 'XOR_SPLIT',
            nodeId,
            tokenId,
            scopeId,
            optionsHash,
            createdAt: now,
          },
        ];
        statePatch.waits = waits;
        emit('DECISION_REQUESTED', { decisionId, nodeId, tokenId, kind: 'XOR_SPLIT' });
        const defaultFlowId = (node as NodeDef & { defaultFlowId?: string }).defaultFlowId;
        const transitions = outgoing.map((f) => {
          const toNodeId = getTargetNode(graph, f.id);
          const targetNode = toNodeId ? graph.nodes[toNodeId] : undefined;
          return {
            flowId: f.id,
            name: f.name,
            conditionExpression: f.conditionExpression,
            isDefault: f.id === defaultFlowId,
            toNodeId,
            targetNodeName: targetNode?.name,
            targetNodeType: targetNode?.type,
          };
        });
        outbox.push({
          instanceId: state._id,
          rootInstanceId: state._id,
          kind: 'CALLBACK_DECISION',
          destination: { url: '' },
          payload: {
            type: 'DECISION_REQUIRED',
            decisionId,
            idempotencyKey: decisionId,
            instanceId: state._id,
            nodeId,
            tokenId,
            scopeId,
            expectedStateVersion: state.version,
            gateway: {
              id: nodeId,
              name: node.name,
              type: node.type,
            },
            transitions,
            evaluation: {
              kind: 'XOR_SPLIT',
              outgoing: outgoing.map((f) => {
                const tn = getTargetNode(graph, f.id);
                return {
                  flowId: f.id,
                  toNodeId: tn,
                  isDefault: f.id === defaultFlowId,
                  name: f.name,
                  conditionExpression: f.conditionExpression,
                  targetNodeName: tn ? graph.nodes[tn]?.name : undefined,
                };
              }),
            },
          },
          status: 'READY',
          attempts: 0,
          nextAttemptAt: now,
          idempotencyKey: decisionId,
          createdAt: now,
          updatedAt: now,
        } as Omit<OutboxDoc, '_id'>);
      } else {
        const outgoingFlow = outgoing[0];
        const toNodeId = outgoingFlow ? getTargetNode(graph, outgoingFlow.id) : undefined;
        const idx = tokens.findIndex((t) => t.tokenId === tokenId);
        if (idx >= 0) tokens[idx] = { ...tokens[idx], status: 'CONSUMED' };
        patchTokens(() => tokens);
        emit('TOKEN_CONSUMED', { tokenId });
        if (toNodeId) {
          const newTokenId = uuidv4();
          emit('TOKEN_CREATED', { tokenId: newTokenId, nodeId: toNodeId, scopeId, status: 'ACTIVE' });
          patchTokens((t) => [
            ...t,
            { tokenId: newTokenId, nodeId: toNodeId, scopeId, status: 'ACTIVE', createdAt: now },
          ]);
          newContinuations.push(
            createTokenAtNodeCont(state._id, newTokenId, toNodeId, scopeId, incoming[0]?.id, now)
          );
        }
      }
    } else if (node.type === 'parallelGateway') {
      const outgoing = getOutgoingFlows(graph, nodeId);
      const incoming = getIncomingFlows(graph, nodeId);
      const isSplit = outgoing.length > 1;
      const incomingFlowId = (continuation.payload as { incomingFlowId?: string }).incomingFlowId;
      if (isSplit) {
        const idx = tokens.findIndex((t) => t.tokenId === tokenId);
        if (idx >= 0) tokens[idx] = { ...tokens[idx], status: 'CONSUMED' };
        emit('TOKEN_CONSUMED', { tokenId });
        for (const flow of outgoing) {
          const toNodeId = getTargetNode(graph, flow.id);
          if (toNodeId) {
            const newTokenId = uuidv4();
            emit('TOKEN_CREATED', { tokenId: newTokenId, nodeId: toNodeId, scopeId, status: 'ACTIVE' });
            tokens.push({
              tokenId: newTokenId,
              nodeId: toNodeId,
              scopeId,
              status: 'ACTIVE',
              createdAt: now,
            });
            newContinuations.push(
              createTokenAtNodeCont(state._id, newTokenId, toNodeId, scopeId, flow.id, now)
            );
          }
        }
        patchTokens(() => [...tokens]);
      } else {
        const flowId = incomingFlowId ?? incoming[0]?.id;
        if (!flowId) {
          return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
        }
        if (!joinArrivals[nodeId]) joinArrivals[nodeId] = {};
        if (!joinArrivals[nodeId][scopeId]) joinArrivals[nodeId][scopeId] = {};
        joinArrivals[nodeId][scopeId][flowId] = tokenId;
        statePatch.joinArrivals = joinArrivals;
        const incomingFlows = getIncomingFlows(graph, nodeId);
        statePatch.version = state.version + 1;
        statePatch.lastEventSeq = lastSeq;
        statePatch.updatedAt = now;
        const requiredFlowIds = incomingFlows.map((f) => f.id);
        const arrived = Object.keys(joinArrivals[nodeId][scopeId]);
        const allArrived = requiredFlowIds.every((id) => arrived.includes(id));
        if (allArrived) {
          const tokenIdsToConsume = requiredFlowIds.map((fid) => joinArrivals[nodeId][scopeId][fid]);
          for (const tid of tokenIdsToConsume) {
            const i = tokens.findIndex((t) => t.tokenId === tid);
            if (i >= 0) tokens[i] = { ...tokens[i], status: 'CONSUMED' };
          }
          patchTokens(() => tokens);
          emit('TOKEN_CONSUMED', { tokenIds: tokenIdsToConsume });
          delete joinArrivals[nodeId][scopeId];
          if (Object.keys(joinArrivals[nodeId]).length === 0) delete joinArrivals[nodeId];
          statePatch.joinArrivals = Object.keys(joinArrivals).length > 0 ? joinArrivals : undefined;
          const outFlow = outgoing[0];
          const toNodeId = outFlow ? getTargetNode(graph, outFlow.id) : undefined;
          if (toNodeId) {
            const newTokenId = uuidv4();
            emit('TOKEN_CREATED', { tokenId: newTokenId, nodeId: toNodeId, scopeId, status: 'ACTIVE' });
            patchTokens((t) => [
              ...t,
              { tokenId: newTokenId, nodeId: toNodeId, scopeId, status: 'ACTIVE', createdAt: now },
            ]);
            newContinuations.push(
              createTokenAtNodeCont(state._id, newTokenId, toNodeId, scopeId, outFlow.id, now)
            );
          }
        }
      }
    } else {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }

    statePatch.version = state.version + 1;
    statePatch.lastEventSeq = lastSeq;
    statePatch.updatedAt = now;
    return { events, statePatch, newContinuations, outbox };
  }

  if (continuation.kind === 'WORK_COMPLETED') {
    const pl = continuation.payload as {
      workItemId: string;
      completedBy?: string;
      completedByDetails?: { email: string; firstName?: string; lastName?: string; phone?: string; photoUrl?: string };
    };
    const { workItemId } = pl;
    const workItem = waits.workItems.find((w) => w.workItemId === workItemId && w.status === 'OPEN');
    if (!workItem) {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }

    const outgoingFlows = getOutgoingFlows(graph, workItem.nodeId);
    const toNodeId = outgoingFlows[0] ? getTargetNode(graph, outgoingFlows[0].id) : undefined;

    waits.workItems = waits.workItems.filter((w) => w.workItemId !== workItemId);
    statePatch.waits = waits;

    const tokenIdx = tokens.findIndex((t) => t.tokenId === workItem.tokenId);
    if (tokenIdx >= 0) {
      tokens[tokenIdx] = { ...tokens[tokenIdx], status: 'CONSUMED' };
      patchTokens(() => tokens);
    }
    emit('TOKEN_CONSUMED', { tokenId: workItem.tokenId });
    const workCompletedPayload: Record<string, unknown> = { workItemId, nodeId: workItem.nodeId };
    if (pl.completedBy != null) workCompletedPayload.completedBy = pl.completedBy;
    if (pl.completedByDetails != null) workCompletedPayload.completedByDetails = pl.completedByDetails;
    emit('WORK_ITEM_COMPLETED', workCompletedPayload);

    if (toNodeId) {
      const flowId = outgoingFlows[0]?.id;
      const newTokenId = uuidv4();
      emit('TOKEN_CREATED', {
        tokenId: newTokenId,
        nodeId: toNodeId,
        scopeId: workItem.scopeId,
        status: 'ACTIVE',
      });
      patchTokens((t) => [
        ...t,
        {
          tokenId: newTokenId,
          nodeId: toNodeId,
          scopeId: workItem.scopeId,
          status: 'ACTIVE',
          createdAt: now,
        },
      ]);
      newContinuations.push(
        createTokenAtNodeCont(state._id, newTokenId, toNodeId, workItem.scopeId, flowId, now)
      );
    }

    statePatch.version = state.version + 1;
    statePatch.dedupe = {
      ...state.dedupe,
      completedWorkItemIds: [...state.dedupe.completedWorkItemIds, workItemId].slice(-1000),
    };
    statePatch.lastEventSeq = lastSeq;
    statePatch.updatedAt = now;
    return { events, statePatch, newContinuations, outbox };
  }

  if (continuation.kind === 'DECISION_RECORDED') {
    const { decisionId, selectedFlowIds } = continuation.payload as {
      decisionId: string;
      selectedFlowIds: string[];
    };
    const decision = waits.decisions.find((d) => d.decisionId === decisionId);
    if (!decision) {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }
    if (decision.kind !== 'XOR_SPLIT') {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }
    const flowId = selectedFlowIds[0];
    if (!flowId) {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }
    const toNodeId = getTargetNode(graph, flowId);
    if (!toNodeId) {
      return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
    }
    waits.decisions = waits.decisions.filter((d) => d.decisionId !== decisionId);
    statePatch.waits = waits;
    const tokenIdx = tokens.findIndex((t) => t.tokenId === decision.tokenId);
    if (tokenIdx >= 0) tokens[tokenIdx] = { ...tokens[tokenIdx], status: 'CONSUMED' };
    patchTokens(() => tokens);
    emit('DECISION_RECORDED', { decisionId, selectedFlowIds });
    emit('TOKEN_CONSUMED', { tokenId: decision.tokenId });
    const newTokenId = uuidv4();
    emit('TOKEN_CREATED', { tokenId: newTokenId, nodeId: toNodeId, scopeId: decision.scopeId, status: 'ACTIVE' });
    patchTokens((t) => [
      ...t,
      { tokenId: newTokenId, nodeId: toNodeId, scopeId: decision.scopeId, status: 'ACTIVE', createdAt: now },
    ]);
    newContinuations.push(
      createTokenAtNodeCont(state._id, newTokenId, toNodeId, decision.scopeId, flowId, now)
    );
    statePatch.version = state.version + 1;
    statePatch.dedupe = {
      ...state.dedupe,
      recordedDecisionIds: [...state.dedupe.recordedDecisionIds, decisionId].slice(-1000),
    };
    statePatch.lastEventSeq = lastSeq;
    statePatch.updatedAt = now;
    return { events, statePatch, newContinuations, outbox };
  }

  return { events: [], statePatch: {}, newContinuations: [], outbox: [] };
}
