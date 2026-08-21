import { vi } from 'vitest';
import { createEmptyProject, totalDuration, type Command, type Project } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { useSelection } from '../stores/selection.js';
import { usePlayback } from '../stores/playback.js';
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND } from '../timeline/scale.js';
import { useView } from '../stores/view.js';
import { useActivity } from '../stores/activity.js';
import { __resetCaptionGeoCacheForTests } from '../player/CaptionLayer.js';

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
  usePlayback.setState({ time: 0, playing: false, total: 0, dragActive: false, trimPreview: null });
  useView.setState({
    pxPerSecond: 40,
    snapEnabled: false,
    leftOpen: true,
    rightOpen: true,
    userZoomed: false,
    // Plan 9 新增欄位：不重置會讓某個測試 fit()/setZoomBounds()/resize 觸發算出的
    // 動態 clamp bounds 洩漏給同檔案後面呼叫 zoomBy/setPxPerSecond/fit 的測試——
    // 這些都讀 get().zoomBounds 去 clampPps，殘留的窄 bounds 會讓後面的斷言算錯
    // （review round 1 抓到：與 store 初始值 `{min: MIN_PX_PER_SECOND, max:
    // MAX_PX_PER_SECOND}` 保持一致，見 view.ts create() 的預設值）。
    zoomBounds: { min: MIN_PX_PER_SECOND, max: MAX_PX_PER_SECOND },
  });
  // activity 是模組級狀態，Inspector 的 AI 區塊與 Activity 面板都讀它。
  // ⚠️ 這行目前「不可達」：實務上每個測試都會走 seedProject()，而
  // applyServerMsg({type:'full'}) 會 `useActivity.seed(msg.history)`（見
  // stores/project.ts），history 是空陣列，等於已經清乾淨了——實測拿掉這行，
  // 連刻意排出污染順序的探針都照樣綠。留著是防禦性的：任何不經 seedProject
  // 直接操作 store 的測試就沒有那層間接清理。**沒有 mutant 守著它**，改動
  // 這裡不會有測試轉紅。
  useActivity.setState({ entries: [] });
  localStorage.clear();
  // CaptionLayer 的 geometry fetch 快取是模組級的，不會隨 store 重置——不清的話，
  // 一個測試檔裡不同 case 重用同一個 text-card hash 會讓後面的測試靜靜地讀到前一個
  // 測試留下的 geometry，看起來像通過但其實測錯東西。
  __resetCaptionGeoCacheForTests();
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
