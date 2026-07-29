import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { WsClientMsg, WsServerMsg } from '@vidcut/shared';
import type { ProjectStore } from './store.js';

/**
 * WS 面（spec §4.1）：連上即發 full；store 變更廣播 patch；收 resync 回 full。
 */
export function attachWs(httpServer: Server, store: ProjectStore): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const send = (ws: WebSocket, msg: WsServerMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const full = (): WsServerMsg => ({ type: 'full', version: store.version, doc: store.doc });

  store.onChange((e) => {
    const msg: WsServerMsg = {
      type: 'patch',
      version: e.version,
      patches: e.patches,
      source: e.source,
      label: e.label,
    };
    for (const client of wss.clients) send(client, msg);
  });

  wss.on('connection', (ws) => {
    send(ws, full());
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsClientMsg;
        if (msg.type === 'resync') send(ws, full());
      } catch {
        // 非 JSON 訊息一律忽略
      }
    });
  });

  return wss;
}
