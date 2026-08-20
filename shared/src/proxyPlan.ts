// ingest 三階段（A0 probe → A1 filmstrip/peaks → A2 proxy）的 A2 判準：
// 純函數，只吃 probe 出來的靜態欄位，決定要不要為這支素材產生代理片、產成什麼樣。
//
// 背景（docs/superpowers/plans/2026-08-20-fast-ingest.md 範圍裁決 §3）：
// - **瀏覽器 codec 相容矩陣**：唯一全平台穩定綠燈的是 H.264 8-bit 4:2:0（yuv420p）；
//   HEVC 只有 Safari 穩，10-bit 幾乎全滅，AV1 看硬解支援。web-compatible H.264 的
//   精確定義＝yuv420p + faststart + bt709（Academy Software Foundation Encoding
//   Guidelines）——已經是這個定義的來源就不需要再轉碼，直接讓瀏覽器吃原檔。
// - **GOP／keyframe 密度門檻**：seek 落點＝前一個 I-frame，GOP 越長 scrub 手感越鈍；
//   串流通用基線是 2 秒（Apple HLS spec），編輯器建議 ≤1–2 秒（coconut.co、
//   liveapi.com）。這裡取 3 秒當「還可接受」的寬限上限——手機/下載原檔常見長 GOP，
//   proxy 的價值一半在 keyframe 密度、不只在解析度，所以跳過 proxy 必須連 keyframe
//   間隔一起把關，不能只看解析度/codec。
//
// 三種結果：
// - `skip`     ：來源已是 web-compatible H.264 直式短 GOP，完全不產 proxy，
//                 播放/抽幀直接吃原檔。
// - `remux`    ：影像層面已合格，只是容器不對（例如 mkv 裝 h264）——`-c copy` 秒級
//                 封裝進 mp4/mov，不重編碼。
// - `transcode`：其餘情況（HEVC/10-bit/超解析度/高 fps/長 GOP/量測失敗或欄位缺席），
//                 走現行完整轉碼參數。
//
// 保守原則：任何一個判準欄位缺席或量不出來，一律視為「不確定」→ `transcode`。
// 快路（skip/remux）只在明確判定安全時才開。

export type ProxyMode = 'skip' | 'remux' | 'transcode';

export interface ProxyPlanInput {
  codec?: string;
  pixFmt?: string;
  container?: string;
  width: number;
  height: number;
  fps: number;
  keyframeIntervalSec?: number;
}

const MAX_DIMENSION = 1920;
const MAX_FPS = 60;
const MAX_KEYFRAME_INTERVAL_SEC = 3;
const MP4_CONTAINERS = new Set(['mp4', 'mov']);

export function proxyPlan(p: ProxyPlanInput): ProxyMode {
  const videoOk =
    p.codec === 'h264' &&
    p.pixFmt === 'yuv420p' &&
    Math.max(p.width, p.height) <= MAX_DIMENSION &&
    p.fps <= MAX_FPS &&
    p.keyframeIntervalSec !== undefined &&
    p.keyframeIntervalSec <= MAX_KEYFRAME_INTERVAL_SEC;

  if (!videoOk) return 'transcode';
  if (p.container === undefined) return 'transcode';
  if (MP4_CONTAINERS.has(p.container)) return 'skip';
  return 'remux';
}
