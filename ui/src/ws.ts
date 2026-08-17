import type {
  Command,
  EditorContextData,
  RenderOptions,
  ReviewOutcome,
  WsServerMsg,
} from '@vidcut/shared';
import { useProject } from './stores/project.js';
import { useToast } from './stores/toast.js';

/** proxy 優先，退回原始檔。 */
export function mediaUrl(m: { proxyPath?: string; path: string }): string {
  return `/media/${m.proxyPath ?? m.path}`;
}

let socket: WebSocket | null = null;

function sendMsg(msg: unknown, offlineWarning?: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else if (offlineWarning) {
    useToast.getState().show(offlineWarning);
  }
}

/** 送編輯命令給 server（localhost 直接等 server echo，不做樂觀更新）。 */
export function sendCommand(cmd: Command, reqId?: string): void {
  sendMsg({ type: 'command', cmd, reqId }, 'Offline — edit not sent');
}

/**
 * 送一則聊天訊息給 AI（經 server 存進 chat.json 並廣播給所有連線）。
 *
 * **不帶離線警告字串**：Chat 分頁在離線時就把輸入框 disabled 了（而且草稿留著），
 * 所以這條路走不到；真的走到也不該冒一個 toast——那個 toast 的措辭是給編輯用的。
 */
export function sendChatMessage(text: string): void {
  sendMsg({ type: 'sendChatMessage', text });
}

/** 回報人在 UI 的脈絡（選取/playhead/範圍）給 AI 的 get_editor_context 讀。 */
export function sendContext(context: EditorContextData): void {
  sendMsg({ type: 'context', context });
}

/** 人核准/退回 AI 的 request_review。 */
export function sendReviewResolve(id: string, outcome: ReviewOutcome, note?: string): void {
  sendMsg({ type: 'reviewResolve', id, outcome, note }, 'Offline — review reply not sent');
}

/** 觸發渲染成品（可帶匯出設定）。 */
export function sendRender(options?: RenderOptions): void {
  sendMsg({ type: 'render', options }, 'Offline — cannot render');
}

/** 用指定時間點的畫面當封面。 */
export function sendSetCover(time: number): void {
  sendMsg({ type: 'setCover', time }, 'Offline — cannot set cover');
}

/** 連 WS：斷線指數退避（1s→10s）重連，重連成功即發 resync 取全量。 */
export function connectWs(url = `ws://${location.host}/ws`): void {
  let delay = 1000;
  const open = () => {
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      delay = 1000;
      useProject.getState().setConnected(true);
      ws.send(JSON.stringify({ type: 'resync' }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as WsServerMsg;
      if (msg.type === 'commandError') {
        useToast.getState().show(`Edit rejected: ${msg.error}`);
        return;
      }
      if (useProject.getState().applyServerMsg(msg) === 'resync') {
        ws.send(JSON.stringify({ type: 'resync' }));
      }
    };
    ws.onclose = () => {
      useProject.getState().setConnected(false);
      if (socket === ws) socket = null;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  };
  open();
}
