import type { WsServerMsg } from '@vidcut/shared';
import { useProject } from './stores/project.js';

/** proxy 優先，退回原始檔。 */
export function mediaUrl(m: { proxyPath?: string; path: string }): string {
  return `/media/${m.proxyPath ?? m.path}`;
}

/** 連 WS：斷線指數退避（1s→10s）重連，重連成功即發 resync 取全量。 */
export function connectWs(url = `ws://${location.host}/ws`): void {
  let delay = 1000;
  const open = () => {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 1000;
      useProject.getState().setConnected(true);
      ws.send(JSON.stringify({ type: 'resync' }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as WsServerMsg;
      if (useProject.getState().applyServerMsg(msg) === 'resync') {
        ws.send(JSON.stringify({ type: 'resync' }));
      }
    };
    ws.onclose = () => {
      useProject.getState().setConnected(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  };
  open();
}
