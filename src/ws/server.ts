/**
 * WebSocket server for push-based callback notifications.
 * Clients connect to receive CALLBACK_WORK and CALLBACK_DECISION events in real time.
 */
import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { addClient, removeClient } from './broadcast';

const WS_PATH = '/ws';

export function attachWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
  });

  wss.on('connection', (ws, req) => {
    addClient(ws);

    ws.on('close', () => {
      removeClient(ws);
    });

    // Optional: client can send { action: 'ping' } for keepalive
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore invalid JSON
      }
    });
  });
}
