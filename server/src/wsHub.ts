import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HistoryBrief, WsClientMsg, WsServerMsg } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import { applyCommand } from './commands.js';

const HISTORY_IN_FULL = 50;

/**
 * WS 面（spec §4.1）：連上即發 full（含最近 history）；store 變更廣播 patch；
 * 收 resync 回 full；收 command 走 applyCommand('human')，失敗回 commandError。
 */
export function attachWs(httpServer: Server, store: ProjectStore): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const send = (ws: WebSocket, msg: WsServerMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const recentHistory = (): HistoryBrief[] =>
    store
      .history()
      .slice(-HISTORY_IN_FULL)
      .map((h) => ({ version: h.version, label: h.label, source: h.source, ts: h.ts }));
  const full = (): WsServerMsg => ({
    type: 'full',
    version: store.version,
    doc: store.doc,
    history: recentHistory(),
  });

  store.onChange((e) => {
    const msg: WsServerMsg = {
      type: 'patch',
      version: e.version,
      patches: e.patches,
      source: e.source,
      label: e.label,
      ts: e.ts,
    };
    for (const client of wss.clients) send(client, msg);
  });

  wss.on('connection', (ws) => {
    send(ws, full());
    ws.on('message', (data) => {
      let msg: WsClientMsg;
      try {
        msg = JSON.parse(data.toString()) as WsClientMsg;
      } catch {
        return; // 非 JSON 訊息一律忽略
      }
      if (msg.type === 'resync') {
        send(ws, full());
      } else if (msg.type === 'command') {
        const result = applyCommand(store, 'human', msg.cmd);
        if (!result.ok) send(ws, { type: 'commandError', reqId: msg.reqId, error: result.error });
      }
    });
  });

  return wss;
}
