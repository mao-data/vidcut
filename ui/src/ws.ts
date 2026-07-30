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
  sendMsg({ type: 'command', cmd, reqId }, '未連線，無法送出編輯');
}

/** 回報人在 UI 的脈絡（選取/playhead/範圍）給 AI 的 get_editor_context 讀。 */
export function sendContext(context: EditorContextData): void {
  sendMsg({ type: 'context', context });
}

/** 人核准/退回 AI 的 request_review。 */
export function sendReviewResolve(id: string, outcome: ReviewOutcome, note?: string): void {
  sendMsg({ type: 'reviewResolve', id, outcome, note }, '未連線，無法回覆審核');
}

/** 觸發渲染成品（可帶匯出設定）。 */
export function sendRender(options?: RenderOptions): void {
  sendMsg({ type: 'render', options }, '未連線，無法渲染');
}

/** 用指定時間點的畫面當封面。 */
export function sendSetCover(time: number): void {
  sendMsg({ type: 'setCover', time }, '未連線，無法設封面');
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
        useToast.getState().show(`編輯被拒：${msg.error}`);
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
