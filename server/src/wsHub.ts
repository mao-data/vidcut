import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HistoryBrief, WsClientMsg, WsServerMsg } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { EditorContext } from './editorContext.js';
import type { ReviewManager } from './reviews.js';
import { applyCommand } from './commands.js';
import { render } from './render.js';

const HISTORY_IN_FULL = 50;

export interface WsDeps {
  store: ProjectStore;
  editorContext?: EditorContext;
  reviews?: ReviewManager;
  projectDir?: string;
}

/**
 * WS 面（spec §4.1）：連上即發 full（含最近 history）；store 變更廣播 patch；
 * 收 resync 回 full；收 command 走 applyCommand('human')；
 * 收 context 更新 EditorContext；收 reviewResolve 交給 ReviewManager。
 */
export function attachWs(httpServer: Server, deps: WsDeps): WebSocketServer {
  const { store, editorContext, reviews, projectDir } = deps;
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
      } else if (msg.type === 'context') {
        editorContext?.set(msg.context);
      } else if (msg.type === 'reviewResolve') {
        reviews?.resolve(msg.id, msg.outcome, msg.note);
      } else if (msg.type === 'render') {
        if (projectDir && store.doc.render.status !== 'running') {
          const stamp = msg.stamp ?? `render_${store.version}`;
          render(store, projectDir, stamp).catch((e: unknown) => {
            store.mutate('ai', 'render error', (d) => {
              d.render = { status: 'error', error: (e as Error).message };
            });
          });
        }
      }
    });
  });

  return wss;
}
