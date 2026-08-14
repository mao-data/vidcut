import type { PeaksFile } from '@vidcut/shared';

/**
 * canvas 沒有 CSS 變數，所以波形顏色一定要在 JS 手上拿到一個字串。
 * 單一真值來源留在 `theme.css`（`--wave-*`），這裡只負責查表。
 *
 * 第二個參數是**僅 jsdom 回退**：測試環境沒有樣式表，`getComputedStyle` 對
 * 每個自訂屬性都回空字串。回退值＝`theme.css` `:root` 的同名 token，
 * 兩邊要一起改（有 mutant 守著「回退永遠生效＝查表失效」這個退化）。
 *
 * ⚠️ 唯一的字面差異是 alpha 的尾零：CSS 端 prettier 會把 `0.30` 正規化成 `0.3`
 * （試過寫 `0.30`，`format:check` 直接紅），JS 這邊保留原本的 `0.30`。
 * 兩者 parse 出來是同一個顏色，canvas 輸出逐像素相同。
 */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

export interface WaveformOpts {
  /** 來源內起點（秒） */
  from: number;
  /** 顯示長度（秒） */
  duration: number;
  /** 峰值包絡層顏色（外層、較淡） */
  peakColor: string;
  /** RMS 能量層顏色（內層、較亮）；無 rms 資料時單層用此色 */
  rmsColor: string;
  /** 中線（預設 true） */
  midline?: boolean;
}

/**
 * 鏡像包絡波形：峰值層＋（有 rms 時）RMS 核心層，devicePixelRatio 級解析度。
 * 片段波形帶與音訊軌共用。canvas 尺寸以 clientWidth/Height 為準（CSS 控制大小）。
 */
export function drawWaveform(cv: HTMLCanvasElement, pf: PeaksFile, opts: WaveformOpts): void {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (W === 0 || H === 0) return;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const bps = pf.sampleRate / pf.samplesPerBucket;
  const first = Math.floor(opts.from * bps);
  const count = Math.max(1, opts.duration * bps);
  const mid = H / 2;
  const pad = 1;
  // 感知縮放：實測素材的正規化振幅常在 0.1–0.3，線性映射會退化成一條細線。
  // sqrt 讓小聲內容仍可辨識（0.09→0.3、0.25→0.5），且保持單調（比較關係不變）。
  const scale = (v: number) => Math.sqrt(v);

  const fill = (data: number[], color: string) => {
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < W; x++) {
      const v = data[first + Math.floor((x / W) * count)] ?? 0;
      ctx.lineTo(x, mid - scale(v) * (mid - pad));
    }
    for (let x = W - 1; x >= 0; x--) {
      const v = data[first + Math.floor((x / W) * count)] ?? 0;
      ctx.lineTo(x, mid + scale(v) * (mid - pad));
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };

  ctx.clearRect(0, 0, W, H);
  if (pf.rms) {
    fill(pf.peaks, opts.peakColor);
    fill(pf.rms, opts.rmsColor);
  } else {
    // 舊 peaks 檔（無 rms）：單層退回
    fill(pf.peaks, opts.rmsColor);
  }
  if (opts.midline !== false) {
    ctx.fillStyle = cssVar('--wave-midline', 'rgba(230, 231, 240, 0.18)');
    ctx.fillRect(0, mid - 0.5, W, 1);
  }
}

/**
 * 影片片段波形帶配色（暗版是紫系）。
 * 是**函數**不是常數：主題可以在執行期切換，值必須每次繪製時重查。
 */
export function clipWave(): { peakColor: string; rmsColor: string } {
  return {
    peakColor: cssVar('--wave-clip-peak', 'rgba(167, 139, 250, 0.30)'),
    rmsColor: cssVar('--wave-clip-rms', 'rgba(196, 181, 253, 0.85)'),
  };
}

/** 音訊軌配色（暗版是青系）。理由同 clipWave。 */
export function audioWave(): { peakColor: string; rmsColor: string } {
  return {
    peakColor: cssVar('--wave-audio-peak', 'rgba(14, 165, 233, 0.30)'),
    rmsColor: cssVar('--wave-audio-rms', 'rgba(125, 211, 252, 0.85)'),
  };
}
