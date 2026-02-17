/**
 * WebSocket broadcast for outbox callback events.
 * Used in REST mode to push CALLBACK_WORK / CALLBACK_DECISION to subscribed clients.
 */
import type { WebSocket } from 'ws';
import type { OutboxDoc } from '../db/collections';

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws);
}

export function broadcastOutbox(entries: Omit<OutboxDoc, '_id'>[]): void {
  const message = JSON.stringify({
    type: 'callbacks',
    items: entries.map((e) => ({
      kind: e.kind,
      instanceId: e.instanceId,
      payload: e.payload,
    })),
  });

  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(message);
      } catch (_err) {
        // Ignore send errors (client may have disconnected)
      }
    }
  }
}
