import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clapperboard, Image } from 'lucide-react';
import { gsap, useGSAP, motionOK } from '../motion.js';
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

/**
 * 頂欄的匯出入口：主鈕（渲染）＋下拉（輸出設定/封面/成品連結）。
 * 取代原本佔一整列的 RenderBar；渲染邏輯（sendRender/sendSetCover）不變。
 */
export function ExportMenu() {
  const render = useProject((s) => s.doc?.render);
  const [open, setOpen] = useState(false);
  const [presetIdx, setPresetIdx] = useState(0);
  const [qualityIdx, setQualityIdx] = useState(1);
  const [fps, setFps] = useState<number | ''>('');
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const running = render?.status === 'running';
  const progress = Math.round((render?.progress ?? 0) * 100);

  // 渲染完成：匯出鈕 pulse 一下提示「好了」
  useGSAP(
    () => {
      if (render?.status === 'done' && btnRef.current && motionOK()) {
        gsap.fromTo(
          btnRef.current,
          { scale: 1 },
          { scale: 1.07, yoyo: true, repeat: 1, duration: 0.18, ease: 'power1.inOut' },
        );
      }
    },
    { scope: rootRef, dependencies: [render?.status] },
  );

  // 下拉開啟：浮現
  useGSAP(
    () => {
      const pop = rootRef.current?.querySelector('[data-export-pop]');
      if (open && pop && motionOK()) {
        gsap.from(pop, { opacity: 0, y: -6, duration: 0.18, ease: 'power2.out' });
      }
    },
    { scope: rootRef, dependencies: [open] },
  );

  // 點外面關閉下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const go = () => {
    const opts: RenderOptions = { ...PRESETS[presetIdx]!.opts, crf: QUALITY[qualityIdx]!.crf };
    if (fps !== '') opts.fps = fps;
    sendRender(opts);
    setOpen(false);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        ref={btnRef}
        className="btn-primary icon-btn"
        onClick={() => (running ? setOpen((o) => !o) : go())}
        title={running ? `渲染中 ${progress}%` : `輸出 ${PRESETS[presetIdx]!.label}`}
      >
        <Clapperboard size={14} />
        {running ? `渲染中 ${progress}%` : '匯出'}
      </button>
      <button
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        title="輸出設定"
        style={{ marginLeft: 4, padding: '6px 5px' }}
      >
        <ChevronDown size={14} />
      </button>

      {open && (
        <div
          data-export-pop
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 50,
            width: 240,
            padding: 12,
            borderRadius: 'var(--r-panel)',
            background: '#1a1d2e',
            border: '1px solid var(--line-strong)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span className="panel-head">輸出設定</span>
          <select value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))}>
            {PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
          <select value={qualityIdx} onChange={(e) => setQualityIdx(Number(e.target.value))}>
            {QUALITY.map((q, i) => (
              <option key={q.label} value={i}>
                畫質：{q.label}
              </option>
            ))}
          </select>
          <select
            value={fps}
            onChange={(e) => setFps(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">fps：專案預設</option>
            <option value={24}>24</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
          <button
            className="icon-btn"
            onClick={() => sendSetCover(usePlayback.getState().time)}
            title="用目前 playhead 的畫面當封面"
          >
            <Image size={14} /> 用目前畫面設封面
          </button>
          <button className="btn-primary" onClick={go} disabled={running}>
            {running ? `渲染中 ${progress}%` : '開始渲染'}
          </button>

          {render?.status === 'done' && render.lastOutput && (
            <a href={`/media/${render.lastOutput}`} target="_blank" rel="noreferrer">
              ✓ 開啟成品（{render.lastOutput.split('/').pop()}）
            </a>
          )}
          {render?.coverPath && (
            <a
              className="tag"
              href={`/media/${render.coverPath}`}
              target="_blank"
              rel="noreferrer"
            >
              封面 ✓
            </a>
          )}
          {render?.status === 'error' && (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>渲染失敗：{render.error}</span>
          )}
        </div>
      )}

      {/* 渲染中的頂欄細進度條（絕對定位貼齊 header 底） */}
      {running && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 60,
            background: 'rgba(255,255,255,0.06)',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: 'linear-gradient(90deg, var(--accent), var(--accent-2))',
              transition: 'width 0.25s ease',
            }}
          />
        </div>
      )}
    </div>
  );
}
