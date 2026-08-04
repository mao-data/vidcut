// 1080×1920 座標系內的字幕層:有卡用卡(和成品同一張圖),沒卡退回 DOM 近似(舊行為)。
import { useEffect, useState } from 'react';
import { activeTokenIndex, karaokeClip, type CaptionItem } from '@vidcut/shared';

interface Geo {
  width: number;
  height: number;
  tokens?: Array<{ x: number; y: number; w: number; h: number }>;
}
const geoCache = new Map<string, Promise<Geo | null>>();
function fetchGeo(hash: string): Promise<Geo | null> {
  if (!geoCache.has(hash)) {
    geoCache.set(
      hash,
      fetch(`/text-card/${hash}.json`)
        .then((r) => (r.ok ? (r.json() as Promise<Geo>) : null))
        .catch(() => null),
    );
  }
  return geoCache.get(hash)!;
}

function CardCaption({
  cap,
  hash,
  time,
  className,
}: {
  cap: CaptionItem;
  hash: string;
  time: number;
  className?: string;
}) {
  const [geo, setGeo] = useState<Geo | null>(null);
  useEffect(() => {
    let live = true;
    void fetchGeo(hash).then((g) => live && setGeo(g));
    return () => {
      live = false;
    };
  }, [hash]);
  if (!geo) return null; // meta 到位前寧可空一幀,不畫錯的
  const active = activeTokenIndex(cap, time);
  const pad = cap.style.stroke ? Math.max(2, Math.floor(cap.style.fontSize / 16)) : 0;
  const clip = geo.tokens ? karaokeClip(geo.tokens, active, pad) : null;
  return (
    <div
      className={className}
      style={{ position: 'absolute', left: 0, top: 1920 * cap.style.y, width: 1080 }}
    >
      <img src={`/text-card/${hash}.base.png`} width={geo.width} height={geo.height} alt="" />
      {clip && (
        <img
          src={`/text-card/${hash}.hl.png`}
          width={geo.width}
          height={geo.height}
          alt=""
          style={{ position: 'absolute', left: 0, top: 0, clipPath: clip }}
        />
      )}
    </div>
  );
}

function ApproxCaption({
  cap,
  time,
  className,
}: {
  cap: CaptionItem;
  time: number;
  className?: string;
}) {
  const active = activeTokenIndex(cap, time);
  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 1920 * cap.style.y,
        textAlign: 'center',
        fontFamily: cap.style.fontFamily,
        fontSize: cap.style.fontSize, // 1080 空間內就是真字級——/3 粗估正式退役
        color: cap.style.fill,
        WebkitTextStroke: cap.style.stroke ? `2px ${cap.style.stroke}` : undefined,
      }}
    >
      {cap.tokens?.length
        ? cap.tokens.map((t, i) => (
            <span key={i} style={{ color: i <= active ? (cap.style.highlight ?? cap.style.fill) : undefined }}>
              {t.text}
            </span>
          ))
        : cap.text}
    </div>
  );
}

export function CaptionLayer({
  captions,
  cards,
  time,
  added,
}: {
  captions: CaptionItem[];
  cards: Record<string, string>;
  time: number;
  /** AI 新增項目的進場動畫標記（capId → 出現順序）；沿用 Player 的 useEditFx 選取結果 */
  added?: ReadonlyMap<string, number>;
}) {
  return (
    <>
      {captions.map((c) => {
        const className = added?.has(c.id) ? 'fx-enter' : undefined;
        return cards[c.id] ? (
          <CardCaption key={c.id} cap={c} hash={cards[c.id]!} time={time} className={className} />
        ) : (
          <ApproxCaption key={c.id} cap={c} time={time} className={className} />
        );
      })}
    </>
  );
}
