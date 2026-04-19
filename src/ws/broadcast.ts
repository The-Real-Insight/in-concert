/**
 * WebSocket broadcast for outbox callbacks and lifecycle events.
 * Used in REST mode to push to subscribed clients.
 * In-process handlers (e.g. worklist projection) also receive notifications.
 */
import type { WebSocket } from 'ws';
import type { OutboxDoc, ProcessInstanceEventDoc } from '../db/collections';

const clients = new Set<WebSocket>();

export type StreamPayload = {
  callbacks?: Array<{ kind: string; instanceId: string; payload: Record<string, unknown> }>;
  lifecycle?: ProcessInstanceEventDoc[];
};

type StreamHandler = (payload: StreamPayload) => void | Promise<void>;

const inProcessHandlers = new Set<StreamHandler>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws);
}

export function addStreamHandler(handler: StreamHandler): () => void {
  inProcessHandlers.add(handler);
  return () => inProcessHandlers.delete(handler);
}

function broadcastToWebSocket(payload: StreamPayload): void {
  const wsPayload: Record<string, unknown> = { ...payload };
  if (payload.callbacks?.length) {
    wsPayload.type = 'callbacks';
    wsPayload.items = payload.callbacks.map((c) => ({ kind: c.kind, instanceId: c.instanceId, payload: c.payload }));
  }
  const message = JSON.stringify(wsPayload);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(message);
      } catch (_err) {
        // Ignore send errors
      }
    }
  }
}

async function notifyHandlers(payload: StreamPayload): Promise<void> {
  for (const h of inProcessHandlers) {
    try {
      await h(payload);
    } catch (err) {
      console.error('Stream handler error:', err);
    }
  }
}

export function broadcastOutbox(entries: Omit<OutboxDoc, '_id'>[]): void {
  const payload: StreamPayload = {
    callbacks: entries.map((e) => ({
      kind: e.kind,
      instanceId: e.instanceId,
      payload: e.payload,
    })),
  };
  broadcastToWebSocket(payload);
  void notifyHandlers(payload);
}

export function broadcastLifecycle(events: ProcessInstanceEventDoc[]): void {
  if (events.length === 0) return;
  const payload: StreamPayload = { lifecycle: events };
  broadcastToWebSocket(payload);
  void notifyHandlers(payload);
}

export function broadcastAll(
  outbox: OutboxDoc[] | Omit<OutboxDoc, '_id'>[],
  events: ProcessInstanceEventDoc[]
): void {
  const payload: StreamPayload = {};
  if (outbox.length > 0) {
    payload.callbacks = outbox.map((e) => ({
      kind: e.kind,
      instanceId: e.instanceId,
      payload: e.payload,
    }));
  }
  if (events.length > 0) {
    payload.lifecycle = events;
  }
  if (payload.callbacks?.length ?? payload.lifecycle?.length) {
    broadcastToWebSocket(payload);
    void notifyHandlers(payload);
  }
}
