import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Clapperboard, Image } from 'lucide-react';
import { gsap, useGSAP, motionOK } from '../motion.js';
import type { RenderOptions } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { sendRender, sendSetCover } from '../ws.js';

/**
 * 輸出檔位是**倍率**,不是寫死的寬高。
 *
 * ⚠️ 舊版三檔直接給死的直式寬高(`{width:720,height:1280}` / `{width:2160,height:3840}`)。
 * 那在 1080×1920 以外的畫布上會**強行輸出直式、把畫面壓變形**:render 只在「單邊給定」
 * 時依畫布比例推算另一邊,兩邊都給且比例不符時不做任何保護(見 render.ts 的 outW/outH)。
 * 橫式專案選「4K」會拿到一支被擠成直式的成品。
 *
 * 現在只送 `width`,高度交給 render 依畫布比例推算——結構上不可能壓變形。
 * 倍率 1 送 `{}`(完全不進 scale 濾鏡,連 lanczos 都不跑),不是送 `width: canvas.width`。
 */
const SCALES: Array<{ mult: number; name: string }> = [
  { mult: 1, name: 'Original' },
  { mult: 2 / 3, name: '0.67×' },
  { mult: 2, name: '2×' },
];

/**
 * 倍率 → 實際輸出尺寸(給標籤顯示用)。
 * ⚠️ **必須取偶數**:h264 的 yuv420p 不吃奇數維度(canvasPresets.ts 也記著這條)。
 * 這裡的取偶式子與 render.ts 的 `even()` 同一套(`max(2, round(n/2)*2)`),否則標籤上
 * 顯示的數字會跟成品實際尺寸差一格,使用者無從得知哪個才是真的。
 */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}
function scaledSize(canvas: { width: number; height: number }, mult: number) {
  if (mult === 1) return { width: canvas.width, height: canvas.height };
  const width = even(canvas.width * mult);
  // 高度照 render 的推算方式從**取偶後的寬**回推,標籤才會與成品一致。
  return { width, height: even((width * canvas.height) / canvas.width) };
}
const QUALITY: Array<{ label: string; crf: number }> = [
  { label: 'High', crf: 18 },
  { label: 'Standard', crf: 20 },
  { label: 'Compact', crf: 24 },
];

/**
 * 頂欄的匯出入口：主鈕（渲染）＋下拉（輸出設定/封面/成品連結）。
 * 取代原本佔一整列的 RenderBar；渲染邏輯（sendRender/sendSetCover）不變。
 */
export function ExportMenu() {
  const render = useProject((s) => s.doc?.render);
  // 畫布尺寸決定每一檔倍率的實際輸出尺寸（標籤要顯示真值）。doc 還沒載入時退回
  // 直式預設，只影響標籤文字——選單此時本來就按不到。
  const canvas = useProject((s) => s.doc?.canvas) ?? { width: 1080, height: 1920 };
  /** 渲染中的進度走旁路訊息（不進 doc）；doc.render.progress 只在起訖時有意義 */
  const liveProgress = useProject((s) => s.renderProgress);
  const [open, setOpen] = useState(false);
  const [scaleIdx, setScaleIdx] = useState(0);
  const [qualityIdx, setQualityIdx] = useState(1);
  const [fps, setFps] = useState<number | ''>('');
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const running = render?.status === 'running';
  const progress = Math.round((liveProgress ?? render?.progress ?? 0) * 100);

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

  /** 這一檔倍率算出來的實際輸出尺寸（標籤與 title 共用）。 */
  const sizeOf = (mult: number) => scaledSize(canvas, mult);
  const currentSize = sizeOf(SCALES[scaleIdx]!.mult);

  const go = () => {
    const mult = SCALES[scaleIdx]!.mult;
    const opts: RenderOptions = { crf: QUALITY[qualityIdx]!.crf };
    // ⚠️ 只送 width，高度讓 render 依畫布比例推算——兩邊都送就等於自己扛「比例要對」的
    // 責任，而那正是舊版壓變形的成因。倍率 1 連 width 都不送（不觸發 scale 濾鏡）。
    if (mult !== 1) opts.width = currentSize.width;
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
        title={
          running ? `Rendering ${progress}%` : `Export ${currentSize.width}×${currentSize.height}`
        }
      >
        <Clapperboard size={14} />
        {running ? `Rendering ${progress}%` : 'Export'}
      </button>
      <button
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        title="Export settings"
        style={{ marginLeft: 4, padding: '6px 4px' }}
      >
        <ChevronDown size={14} />
      </button>

      {open && (
        <div
          data-export-pop
          className="popover popover-menu"
          style={{
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 50,
            width: 240,
          }}
        >
          <span className="panel-head">Export settings</span>
          <select value={scaleIdx} onChange={(e) => setScaleIdx(Number(e.target.value))}>
            {SCALES.map((s, i) => {
              const { width, height } = sizeOf(s.mult);
              return (
                <option key={s.name} value={i}>
                  {s.name} — {width}×{height}
                </option>
              );
            })}
          </select>
          <select value={qualityIdx} onChange={(e) => setQualityIdx(Number(e.target.value))}>
            {QUALITY.map((q, i) => (
              <option key={q.label} value={i}>
                Quality: {q.label}
              </option>
            ))}
          </select>
          <select
            value={fps}
            onChange={(e) => setFps(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">fps: project default</option>
            <option value={24}>24</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
          <button
            className="icon-btn"
            onClick={() => sendSetCover(usePlayback.getState().time)}
            title="Use the current playhead frame as the cover"
          >
            <Image size={13} /> Set cover from current frame
          </button>
          <button className="btn-primary" onClick={go} disabled={running}>
            {running ? `Rendering ${progress}%` : 'Start render'}
          </button>

          {render?.status === 'done' && render.lastOutput && (
            <a
              href={`/media/${render.lastOutput}`}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Check size={13} /> Open output ({render.lastOutput.split('/').pop()})
            </a>
          )}
          {render?.coverPath && (
            <a
              className="tag"
              href={`/media/${render.coverPath}`}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {/* size 11:.tag 字級 11 的行內綴飾,13 會壓過文字(兩級制例外,theme.css 有記) */}
              Cover <Check size={11} />
            </a>
          )}
          {render?.status === 'error' && (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>
              Render failed: {render.error}
            </span>
          )}

          {render?.status === 'done' && (
            <>
              <span className="panel-head">Upload</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a
                  className="tag"
                  href="https://www.tiktok.com/tiktokstudio/upload"
                  target="_blank"
                  rel="noreferrer"
                >
                  TikTok
                </a>
                <a
                  className="tag"
                  href="https://studio.youtube.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  YouTube
                </a>
                <a
                  className="tag"
                  href="https://www.instagram.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Instagram
                </a>
                <a
                  className="tag"
                  href="https://www.facebook.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Facebook
                </a>
              </div>
              {render.publish && (
                <>
                  <span className="panel-head">Publish package</span>
                  {render.publish.files.map((f) => (
                    <a
                      key={f}
                      href={`/media/${f}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12 }}
                    >
                      {f.split('/').pop()}
                    </a>
                  ))}
                  {render.publish.warnings.map((w) => (
                    <span key={w} style={{ fontSize: 12, opacity: 0.85 }}>
                      ⚠ {w}
                    </span>
                  ))}
                </>
              )}
            </>
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
            background: 'var(--tint-06)',
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
