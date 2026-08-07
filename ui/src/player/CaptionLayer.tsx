// 1080×1920 座標系內的字幕層:有卡用卡(和成品同一張圖),沒卡退回 DOM 近似(舊行為)。
import { Fragment, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { activeTokenIndex, karaokeClip, tokenSeparator, type CaptionItem } from '@vidcut/shared';
import type { EditDraftState } from '../stores/editDraft.js';

/**
 * 拖曳掛鉤：外層卡片只掛 pointerdown（畫布拖字幕 y，見 Player.tsx）。
 * move/up/cancel 一律由 Player 掛在 window 上——字幕卡在手勢進行中被卸載/重掛是常態
 * （出時間窗、hash 變、ApproxCaption↔CardCaption 互換），掛在卡片上的 pointerup 到那時
 * 就永遠不會來了，命令送不出去、本地覆寫卻永久卡住（見 Player.tsx beginDrag 的長註解）。
 */
interface DragHooks {
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

interface Geo {
  width: number;
  height: number;
  /** 墨跡的水平範圍（卡片座標，含描邊）。見下方 inkStyle 與 server/src/rasterizer.ts 的 CardGeometry。 */
  ink?: { x: number; w: number };
  tokens?: Array<{ x: number; y: number; w: number; h: number }>;
}

/**
 * 字幕卡的**命中框**：只蓋住真的有墨跡的地方，不是整張卡。
 *
 * 字卡一律是畫布全寬（1080）、文字水平置中，所以短字幕的 PNG 兩側各有一大片透明。
 * 瀏覽器對 `<img>`/`<div>` 的命中測試只看盒子、不看 alpha，所以外層若用整張卡的框，
 * 那一整條橫貫畫布的帶狀區域就會吃掉所有 pointer 事件——字幕層畫在 overlay 之上
 * （DOM 順序在後），playhead 停在一句字幕上時，落在那個帶子裡的 overlay 就再也選不到、
 * 拖不動了。自動換行上線後這條帶子還會變高（多行卡），影響範圍更大（2026-08-05 修）。
 *
 * 做法是把外層縮到 ink，圖再用等量的負 left 推回卡片原位——**畫出來的像素一個都沒動**
 * （這條路徑餵給 verify:wysiwyg 比對成品，動到就會當場變紅）。
 * 垂直方向不縮：卡高本來就是照行數算的，已經貼著文字。
 * `ink` 是後加的欄位，舊快取沒有 → 退回整張卡的框（＝修之前的行為），不會壞掉只是不夠準；
 * server 那邊會把「缺 ink 的 .json」當快取未命中重畫，所以這個退路只在重畫完成前短暫存在。
 */
function inkStyle(geo: Geo): { box: { left: number; width: number }; imgLeft: number } {
  const x = geo.ink?.x ?? 0;
  return { box: { left: x, width: geo.ink?.w ?? geo.width }, imgLeft: -x };
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
  drag,
}: {
  cap: CaptionItem;
  hash: string;
  time: number;
  className?: string;
  drag?: DragHooks;
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
  if (geo === 'failed')
    return <ApproxCaption cap={cap} time={time} className={className} drag={drag} />;

  const active = activeTokenIndex(cap, time);
  const pad = cap.style.stroke ? strokeWidth(cap.style.fontSize) : 0;
  const clip = geo.tokens ? karaokeClip(geo.tokens, active, pad) : null;
  const { box, imgLeft } = inkStyle(geo);
  return (
    <div
      className={className}
      data-drag-kind="caption"
      onPointerDown={drag?.onPointerDown}
      style={{
        position: 'absolute',
        left: box.left,
        top: 1920 * cap.style.y,
        width: box.width,
        height: geo.height,
        pointerEvents: 'auto',
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      <img
        src={`/text-card/${hash}.base.png`}
        width={geo.width}
        height={geo.height}
        alt=""
        // 外層縮到墨跡寬（見 inkStyle），圖用等量負 left 推回卡片原位——畫面零位移。
        style={{ position: 'absolute', left: imgLeft, top: 0 }}
        // <img> 預設瀏覽器原生可拖曳——外層卡片 div 的 pointerdown/move/up 是畫布拖曳
        // 字幕 y 的手勢(見 Player.tsx onCaptionPointerDown),按下點幾乎必然落在這張
        // 滿版的卡片圖上;不關掉原生拖曳,一移動原生手勢就搶走事件序列(dragstart→
        // pointercancel),pointerup 永遠到不了,字幕拖曳會跟 overlay 拖曳一樣「看起來動了
        // 但沒存到」。
        draggable={false}
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
          draggable={false}
          // clip-path 的座標是卡片自己的座標系（karaokeClip 用的是 tokens 的 bbox），
          // 跟著圖一起被 imgLeft 平移，不受外層縮框影響。
          style={{ position: 'absolute', left: imgLeft, top: 0, clipPath: clip }}
        />
      )}
    </div>
  );
}

function CardCaption(props: {
  cap: CaptionItem;
  hash: string;
  time: number;
  className?: string;
  drag?: DragHooks;
}) {
  return <CardCaptionForHash key={props.hash} {...props} />;
}

function ApproxCaption({
  cap,
  time,
  className,
  drag,
}: {
  cap: CaptionItem;
  time: number;
  className?: string;
  drag?: DragHooks;
}) {
  const active = activeTokenIndex(cap, time);
  return (
    // 外層只負責「全寬置中」的版面，命中框在裡面那層（見 inkStyle 的長註解：全寬的
    // 透明帶子會吃掉底下 overlay 的 pointer 事件）。這條路徑沒有字卡幾何可用，
    // 但它是真的文字節點——inline-block 讓盒子自然收縮到文字本身，比幾何更準。
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 1920 * cap.style.y,
        textAlign: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        className={className}
        data-drag-kind="caption"
        onPointerDown={drag?.onPointerDown}
        style={{
          display: 'inline-block',
          maxWidth: '100%',
          // 這條路徑是「真的文字節點」，不像字卡那條是兩張 draggable={false} 的 <img>：
          // 不關掉選取的話，在字上按下再移動就會選到字（真 Chromium 實測會發 selectstart），
          // 而在**已選取的文字**上開始的下一次拖曳會被瀏覽器判定成原生 text drag：
          // dragstart → pointercancel，pointerup 永不到達，就是 CLAUDE.md 記過的那種
          // 「畫面上動了、命令沒送出」靜默失敗。加 user-select:none 後實測 selectstart 消失，
          // 這個入口就從源頭沒了（收尾路徑的保險絲另外做在 Player.tsx 的 finishDrag）。
          userSelect: 'none',
          WebkitUserSelect: 'none',
          fontFamily: cap.style.fontFamily,
          fontSize: cap.style.fontSize, // 1080 空間內就是真字級——/3 粗估正式退役
          color: cap.style.fill,
          WebkitTextStroke: cap.style.stroke
            ? `${strokeWidth(cap.style.fontSize)}px ${cap.style.stroke}`
            : undefined,
          pointerEvents: 'auto',
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        {cap.tokens?.length
          ? cap.tokens.map((t, i) => (
              // Fragment(非 <span>)包分隔白:分隔白不進 DOM 元素,詞的 <span> 才不會多一層
              // textContent 相同的外殼——上一版用 <span> 包過,首詞(分隔白="")的外層跟內層
              // textContent 會撞在一起,靠 textContent 找 span 的測試會誤選到外層(沒有 color)。
              <Fragment key={i}>
                {i > 0 ? tokenSeparator(cap.tokens![i - 1]!.text, t.text) : ''}
                <span
                  style={{
                    color: i <= active ? (cap.style.highlight ?? cap.style.fill) : undefined,
                  }}
                >
                  {t.text}
                </span>
              </Fragment>
            ))
          : cap.text}
      </div>
    </div>
  );
}

export function CaptionLayer({
  captions,
  cards,
  time,
  added,
  draft,
  onCaptionPointerDown,
}: {
  captions: CaptionItem[];
  cards: Record<string, string>;
  time: number;
  /** AI 新增項目的進場動畫標記（capId → 出現順序）；沿用 Player 的 useEditFx 選取結果 */
  added?: ReadonlyMap<string, number>;
  /**
   * 打字三段式的第一、二段：命中該句時用 draft.text 覆寫顯示——
   * previewHash 有值（第二段已回來）就當單卡畫，否則退回 DOM 近似（第一段，零延遲）。
   * 草稿文字沒有對得上的逐詞時間戳（舊 tokens 屬於改字前的文字），
   * 兩條路徑都必須不帶 tokens，不然 karaoke 高亮會照著錯的詞界跑。
   */
  draft?: EditDraftState['caption'];
  /** 畫布拖曳字幕 y（見 Player.tsx）：外層卡片 pointerdown 帶對應 CaptionItem，之後由 window 接手。 */
  onCaptionPointerDown?: (e: ReactPointerEvent<HTMLDivElement>, cap: CaptionItem) => void;
}) {
  return (
    <>
      {captions.map((c) => {
        const className = added?.has(c.id) ? 'fx-enter' : undefined;
        const drag: DragHooks = {
          onPointerDown: onCaptionPointerDown ? (e) => onCaptionPointerDown(e, c) : undefined,
        };
        if (draft?.id === c.id) {
          const draftCap: CaptionItem = { ...c, text: draft.text, tokens: undefined };
          return draft.previewHash ? (
            <CardCaption
              key={c.id}
              cap={draftCap}
              hash={draft.previewHash}
              time={time}
              className={className}
              drag={drag}
            />
          ) : (
            <ApproxCaption
              key={c.id}
              cap={draftCap}
              time={time}
              className={className}
              drag={drag}
            />
          );
        }
        return cards[c.id] ? (
          <CardCaption
            key={c.id}
            cap={c}
            hash={cards[c.id]!}
            time={time}
            className={className}
            drag={drag}
          />
        ) : (
          <ApproxCaption key={c.id} cap={c} time={time} className={className} drag={drag} />
        );
      })}
    </>
  );
}
