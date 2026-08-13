import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HistoryBrief, WsClientMsg, WsServerMsg } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { EditorContext } from './editorContext.js';
import type { ReviewManager } from './reviews.js';
import type { CaptionCardSync } from './cardSync.js';
import type { TextCardService } from './textCards.js';
import { applyCommand } from './commands.js';
import { resolveTextCommand } from './textOverlays.js';
import { extractCover, render, renderProgressBus } from './render.js';

const HISTORY_IN_FULL = 50;

export interface WsDeps {
  store: ProjectStore;
  editorContext?: EditorContext;
  reviews?: ReviewManager;
  projectDir?: string;
  cardSync?: CaptionCardSync;
  textCards?: TextCardService;
}

/**
 * WS 面（spec §4.1）：連上即發 full（含最近 history）；store 變更廣播 patch；
 * 收 resync 回 full；收 command 走 applyCommand('human')；
 * 收 context 更新 EditorContext；收 reviewResolve 交給 ReviewManager。
 */
export function attachWs(httpServer: Server, deps: WsDeps): WebSocketServer {
  const { store, editorContext, reviews, projectDir, cardSync, textCards } = deps;
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  // command 需要先 await resolveTextCommand(可能產卡)才 applyCommand，
  // 但訊息必須按抵達順序生效——串成一條 queue，逐一 resolve-then-apply，
  // 錯誤在每個任務內吞掉（送 commandError），不讓 queue 卡死或中斷。
  let commandQueue: Promise<void> = Promise.resolve();

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

  renderProgressBus.on('progress', (progress: number) => {
    const msg: WsServerMsg = { type: 'renderProgress', progress };
    for (const client of wss.clients) send(client, msg);
  });

  if (cardSync) {
    cardSync.onReady = (entries) => {
      const msg: WsServerMsg = { type: 'textCards', entries };
      for (const client of wss.clients) send(client, msg);
    };
  }

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
    if (cardSync && e.patches.some((p) => p.path[0] === 'tracks' && p.path[1] === 'captions')) {
      cardSync.schedule();
    }
  });

  wss.on('connection', (ws) => {
    send(ws, full());
    if (cardSync && cardSync.latest.length > 0) {
      send(ws, { type: 'textCards', entries: cardSync.latest });
    }
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
        const cmd = msg.cmd;
        const reqId = msg.reqId;
        const run = async (): Promise<void> => {
          try {
            const resolved = textCards ? await resolveTextCommand(textCards, store, cmd) : cmd;
            const result = applyCommand(store, 'human', resolved);
            if (!result.ok) send(ws, { type: 'commandError', reqId, error: result.error });
          } catch (e) {
            send(ws, {
              type: 'commandError',
              reqId,
              error: `text card generation failed: ${(e as Error).message}`,
            });
          }
        };
        commandQueue = commandQueue.then(run, run);
      } else if (msg.type === 'context') {
        editorContext?.set(msg.context);
      } else if (msg.type === 'reviewResolve') {
        reviews?.resolve(msg.id, msg.outcome, msg.note);
      } else if (msg.type === 'render') {
        if (projectDir && store.doc.render.status !== 'running') {
          const stamp = msg.stamp ?? `render_${store.version}`;
          render(store, projectDir, stamp, msg.options).catch((e: unknown) => {
            store.mutate('ai', 'render error', (d) => {
              d.render = { status: 'error', error: (e as Error).message };
            });
          });
        }
      } else if (msg.type === 'setCover') {
        if (projectDir) {
          extractCover(store, projectDir, msg.time).catch((e: unknown) => {
            send(ws, {
              type: 'commandError',
              error: `cover generation failed: ${(e as Error).message}`,
            });
          });
        }
      }
    });
  });

  return wss;
}
