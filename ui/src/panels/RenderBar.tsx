import { useState } from 'react';
import type { RenderOptions } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { sendRender, sendSetCover } from '../ws.js';

/** 常用直式短影音輸出檔位（平台建議 1080×1920@30）。 */
const PRESETS: Array<{ label: string; opts: RenderOptions }> = [
  { label: '1080×1920', opts: {} },
  { label: '720×1280', opts: { width: 720, height: 1280 } },
  { label: '4K 2160×3840', opts: { width: 2160, height: 3840 } },
];
const QUALITY: Array<{ label: string; crf: number }> = [
  { label: '高', crf: 18 },
  { label: '標準', crf: 20 },
  { label: '省空間', crf: 24 },
];

const sel: React.CSSProperties = {
  background: '#222',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 3,
  fontSize: 11,
  padding: '2px 4px',
};

/** 渲染按鈕 + 匯出設定 + 進度 + 成品/封面連結。 */
export function RenderBar() {
  const render = useProject((s) => s.doc?.render);
  const [presetIdx, setPresetIdx] = useState(0);
  const [qualityIdx, setQualityIdx] = useState(1);
  const [fps, setFps] = useState<number | ''>('');
  const running = render?.status === 'running';

  const go = () => {
    const opts: RenderOptions = { ...PRESETS[presetIdx]!.opts, crf: QUALITY[qualityIdx]!.crf };
    if (fps !== '') opts.fps = fps;
    sendRender(opts);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderTop: '1px solid #333',
        flexWrap: 'wrap',
      }}
    >
      <button onClick={go} disabled={running} style={{ padding: '6px 14px' }}>
        {running ? '渲染中…' : '🎬 渲染成品'}
      </button>

      <select
        style={sel}
        value={presetIdx}
        onChange={(e) => setPresetIdx(Number(e.target.value))}
        title="輸出解析度"
      >
        {PRESETS.map((p, i) => (
          <option key={p.label} value={i}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        style={sel}
        value={qualityIdx}
        onChange={(e) => setQualityIdx(Number(e.target.value))}
        title="品質（crf）"
      >
        {QUALITY.map((q, i) => (
          <option key={q.label} value={i}>
            畫質：{q.label}
          </option>
        ))}
      </select>
      <select
        style={sel}
        value={fps}
        onChange={(e) => setFps(e.target.value === '' ? '' : Number(e.target.value))}
        title="fps"
      >
        <option value="">fps：專案預設</option>
        <option value={24}>24</option>
        <option value={30}>30</option>
        <option value={60}>60</option>
      </select>

      <button
        onClick={() => sendSetCover(usePlayback.getState().time)}
        title="用目前 playhead 的畫面當封面"
      >
        🖼 設封面
      </button>

      {running && (
        <div
          style={{
            flex: 1,
            minWidth: 120,
            maxWidth: 300,
            height: 8,
            background: '#333',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.round((render?.progress ?? 0) * 100)}%`,
              height: '100%',
              background: '#4af',
              transition: 'width 0.2s',
            }}
          />
        </div>
      )}
      {render?.status === 'done' && render.lastOutput && (
        <a
          href={`/media/${render.lastOutput}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#6cf' }}
        >
          ✓ 開啟成品（{render.lastOutput.split('/').pop()}）
        </a>
      )}
      {render?.coverPath && (
        <a
          href={`/media/${render.coverPath}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#9c9' }}
        >
          封面 ✓
        </a>
      )}
      {render?.status === 'error' && (
        <span style={{ color: '#f66' }}>渲染失敗：{render.error}</span>
      )}
    </div>
  );
}
