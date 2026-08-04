// 1080×1920 座標系內的字幕層:有卡用卡(和成品同一張圖),沒卡退回 DOM 近似(舊行為)。
import { Fragment, useEffect, useState } from 'react';
import { activeTokenIndex, karaokeClip, tokenSeparator, type CaptionItem } from '@vidcut/shared';

interface Geo {
  width: number;
  height: number;
  tokens?: Array<{ x: number; y: number; w: number; h: number }>;
}

/** 進行中/已解析的 fetch 快取:只快取「進行中」與「成功」——失敗絕不長駐,見下。 */
const geoCache = new Map<string, Promise<Geo | 'failed'>>();
/**
 * 已解析值的同步快取，供 `useState` 的惰性初始器讀（見 CardCaptionForHash）——
 * 有這層,暖快取（同一個 hash 早就抓過）就不用空等一幀才畫出來（Minor：warm-cache 不空幀）。
 */
const geoResolved = new Map<string, Geo | 'failed'>();

function fetchGeo(hash: string): Promise<Geo | 'failed'> {
  if (!geoCache.has(hash)) {
    const p: Promise<Geo | 'failed'> = fetch(`/text-card/${hash}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Geo>) : Promise.reject(new Error(`${r.status}`))))
      .then((g) => {
        geoResolved.set(hash, g);
        return g;
      })
      .catch(() => {
        // 失敗（404／網路錯誤）不永久快取:從 geoCache 移除,下次掛載會重新 fetch。
        // 快取失敗會讓一次暫時性故障就把這句字幕永久畫成空白（Finding 1）。
        geoResolved.set(hash, 'failed');
        geoCache.delete(hash);
        return 'failed' as const;
      });
    geoCache.set(hash, p);
  }
  return geoCache.get(hash)!;
}

/** 測試專用：清掉模組級快取，避免不同測試（或同一測試檔的不同 case）用同一個 hash 卻互相污染。 */
export function __resetCaptionGeoCacheForTests(): void {
  geoCache.clear();
  geoResolved.clear();
}

/** 與 rasterizer 的 stroke_w 公式一致（server/scripts/text_card.py: `max(2, size // 16)`）。 */
function strokeWidth(fontSize: number): number {
  return Math.max(2, Math.floor(fontSize / 16));
}

/**
 * 實際做 fetch/render 的內層元件，用 `key={hash}` 掛在外層（見 CardCaption）。
 * hash 變就整個重新掛載——state 天然歸零，不會有「新 hash 沿用舊 geometry」的縫隙
 * （Finding 3）；`useState` 惰性初始器直接讀 geoResolved，暖快取不空幀。
 */
function CardCaptionForHash({
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
  const [geo, setGeo] = useState<Geo | 'pending' | 'failed'>(
    () => geoResolved.get(hash) ?? 'pending',
  );
  useEffect(() => {
    let live = true;
    void fetchGeo(hash).then((g) => {
      if (live) setGeo(g);
    });
    return () => {
      live = false;
    };
  }, [hash]);

  if (geo === 'pending') return null; // 首次抓取中:寧可空一幀,不畫錯的
  if (geo === 'failed') return <ApproxCaption cap={cap} time={time} className={className} />;

  const active = activeTokenIndex(cap, time);
  const pad = cap.style.stroke ? strokeWidth(cap.style.fontSize) : 0;
  const clip = geo.tokens ? karaokeClip(geo.tokens, active, pad) : null;
  return (
    <div
      className={className}
      style={{ position: 'absolute', left: 0, top: 1920 * cap.style.y, width: 1080 }}
    >
      <img
        src={`/text-card/${hash}.base.png`}
        width={geo.width}
        height={geo.height}
        alt=""
        // 幾何 fetch 成功不保證圖檔本身能載入(競態的部分產出、快取被清等)——
        // 圖載入失敗就整句退回 DOM fallback,不留一張看不到的卡在畫面上（Finding 1）。
        onError={() => setGeo('failed')}
      />
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

function CardCaption(props: { cap: CaptionItem; hash: string; time: number; className?: string }) {
  return <CardCaptionForHash key={props.hash} {...props} />;
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
        WebkitTextStroke: cap.style.stroke
          ? `${strokeWidth(cap.style.fontSize)}px ${cap.style.stroke}`
          : undefined,
      }}
    >
      {cap.tokens?.length
        ? cap.tokens.map((t, i) => (
            // Fragment(非 <span>)包分隔白:分隔白不進 DOM 元素,詞的 <span> 才不會多一層
            // textContent 相同的外殼——上一版用 <span> 包過,首詞(分隔白="")的外層跟內層
            // textContent 會撞在一起,靠 textContent 找 span 的測試會誤選到外層(沒有 color)。
            <Fragment key={i}>
              {i > 0 ? tokenSeparator(cap.tokens![i - 1]!.text, t.text) : ''}
              <span style={{ color: i <= active ? (cap.style.highlight ?? cap.style.fill) : undefined }}>
                {t.text}
              </span>
            </Fragment>
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
