import { vi } from 'vitest';
import { createEmptyProject, totalDuration, type Command, type Project } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { useSelection } from '../stores/selection.js';
import { usePlayback } from '../stores/playback.js';
import { useView } from '../stores/view.js';

/**
 * 元件測試用的示範專案：2 段影片（第 2 段定格）、1 條音訊、1 張錨定疊圖、
 * 1 張絕對式疊圖、2 句字幕（第 2 句有逐詞 tokens）。
 * 時間軸：clip c1 = 0–6s、c2 = 6–10s，總長 10s。
 */
export function demoProject(): Project {
  const p = createEmptyProject('demo', 'demo');
  p.canvas = { width: 1080, height: 1920, fps: 30 };
  p.media = [
    {
      id: 'm1',
      path: 'src/a.mp4',
      proxyPath: 'derived/m1/proxy.mp4',
      peaksPath: 'derived/m1/peaks.json',
      filmstripPath: 'derived/m1/strip.jpg',
      probe: { duration: 30, width: 1080, height: 1920, fps: 30, hasAudio: true, rotation: 0 },
      label: 'A',
    },
    {
      id: 'm2',
      path: 'src/b.mp4',
      proxyPath: 'derived/m2/proxy.mp4',
      peaksPath: 'derived/m2/peaks.json',
      probe: { duration: 30, width: 1080, height: 1920, fps: 30, hasAudio: true, rotation: 0 },
      label: 'B',
    },
  ];
  p.tracks.video = [
    { id: 'c1', mediaId: 'm1', in: 2, duration: 6, volume: 1, label: 'clip one' },
    { id: 'c2', mediaId: 'm2', in: 0, duration: 4, volume: 1, label: 'clip two', frozen: true },
  ];
  p.tracks.audio = [
    { id: 'a1', mediaId: 'm2', start: 2, in: 1, duration: 5, volume: 0.8, label: 'bgm' },
  ];
  p.tracks.overlays = [
    {
      id: 'ovAbs',
      imagePath: 'assets/title.png',
      start: 1,
      duration: 3,
      position: { x: 0.5, y: 0.1, scale: 1 },
    },
    {
      id: 'ovAnchor',
      imagePath: 'assets/badge.png',
      anchor: { clipId: 'c2', offset: 0.5 },
      duration: 2,
      position: { x: 0.5, y: 0.5, scale: 1 },
    },
  ];
  p.tracks.captions = [
    {
      id: 'cap1',
      text: 'first line',
      start: 1,
      duration: 3,
      style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#ffffff', y: 0.8 },
    },
    {
      id: 'cap2',
      text: 'second line',
      start: 5,
      duration: 3,
      style: {
        fontFamily: 'sans-serif',
        fontSize: 48,
        fill: '#ffffff',
        y: 0.8,
        highlight: '#fbbf24',
      },
      tokens: [
        { text: 'second', start: 5, end: 6.5 },
        { text: 'line', start: 6.5, end: 8 },
      ],
    },
  ];
  return p;
}

/**
 * 把專案灌進 store（走真正的 applyServerMsg，不直接寫 state）。
 * 同時設定播放總長——正式執行時是 Player mount 後做的，
 * 沒設的話 seek() 會被 clamp 到 0，測試會拿到假的 playhead。
 */
export function seedProject(doc: Project = demoProject(), version = 1): Project {
  useProject.getState().applyServerMsg({ type: 'full', version, doc, history: [] });
  useProject.getState().setConnected(true);
  usePlayback.getState().setTotal(totalDuration(doc));
  return doc;
}

/** 每個測試前把所有 store 歸零，避免測試互相污染。 */
export function resetStores(): void {
  useProject.setState({ doc: null, version: 0, connected: false, captionCards: {} });
  useSelection.setState({ selected: null });
  usePlayback.setState({ time: 0, playing: false, total: 0 });
  useView.setState({ pxPerSecond: 40, snapEnabled: false, leftOpen: true, rightOpen: true });
  localStorage.clear();
}

/**
 * 攔截送往 server 的命令。回傳的陣列會依序收集 sendCommand 的參數。
 * 這是**邊界** mock（WebSocket），不是被測邏輯。
 */
export function captureCommands(wsModule: { sendCommand: (c: Command) => void }): Command[] {
  const sent: Command[] = [];
  vi.spyOn(wsModule, 'sendCommand').mockImplementation((c: Command) => {
    sent.push(c);
  });
  return sent;
}
