import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import type { AudioItem } from '@vidcut/shared';
import { tmpDir } from './tmp.js';

async function storeWithClips() {
  const dir = await tmpDir('vidcut-cmd-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed', (d) => {
    d.media = [
      {
        id: 'm1',
        path: 'a.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
      {
        id: 'm2',
        path: 'b.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
    ];
    d.tracks.video = [
      { id: 'c1', mediaId: 'm1', in: 2, duration: 5, volume: 1, label: 'No.1' },
      { id: 'c2', mediaId: 'm2', in: 0, duration: 4, volume: 1, label: 'No.2' },
    ];
    d.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 0,
        duration: 3,
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
  });
  return store;
}

describe('applyCommand', () => {
  it('updateClip trims within source bounds', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { duration: 6 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.duration).toBe(6);
  });

  it('updateClip rejects trim beyond source duration', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { in: 18, duration: 5 }, // 18+5=23 > 20
    });
    expect(r).toMatchObject({ ok: false });
    expect(store.doc.tracks.video[0]!.in).toBe(2); // 未變
  });

  it('updateClip rejects negative in and tiny duration', async () => {
    const store = await storeWithClips();
    expect(
      applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { in: -1 } }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { duration: 0.01 } })
        .ok,
    ).toBe(false);
  });

  it('reorderClips requires a permutation', async () => {
    const store = await storeWithClips();
    expect(applyCommand(store, 'human', { name: 'reorderClips', order: ['c2', 'c1'] }).ok).toBe(
      true,
    );
    expect(store.doc.tracks.video.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(applyCommand(store, 'human', { name: 'reorderClips', order: ['c1'] }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'reorderClips', order: ['c1', 'c1'] }).ok).toBe(
      false,
    );
  });

  it('removeClip removes existing and rejects missing', async () => {
    const store = await storeWithClips();
    expect(applyCommand(store, 'human', { name: 'removeClip', clipId: 'c2' }).ok).toBe(true);
    expect(store.doc.tracks.video).toHaveLength(1);
    expect(applyCommand(store, 'human', { name: 'removeClip', clipId: 'nope' }).ok).toBe(false);
  });

  it('updateCaption edits text; undo reverts', async () => {
    const store = await storeWithClips();
    const before = store.version;
    applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { text: 'changed' },
    });
    expect(store.doc.tracks.captions[0]!.text).toBe('changed');
    const u = applyCommand(store, 'human', { name: 'undo' });
    expect(u.ok).toBe(true);
    expect(store.doc.tracks.captions[0]!.text).toBe('hi');
    expect(store.version).toBeGreaterThan(before);
  });

  it('undo on empty history fails gracefully', async () => {
    const dir = await tmpDir('vidcut-cmd-');
    const store = await ProjectStore.load(join(dir, 'project.json'));
    expect(applyCommand(store, 'human', { name: 'undo' })).toMatchObject({ ok: false });
  });
});

describe('updateOverlay anchor/start exclusivity', () => {
  async function storeWithOverlays() {
    const store = await storeWithClips();
    store.mutate('ai', 'seed overlays', (d) => {
      d.tracks.overlays = [
        {
          id: 'ov_abs',
          imagePath: 'a.png',
          start: 2,
          duration: 3,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
        {
          id: 'ov_anc',
          imagePath: 'b.png',
          anchor: { clipId: 'c2', offset: 1 },
          duration: null,
          position: { x: 0.5, y: 0.2, scale: 1 },
        },
      ];
    });
    return store;
  }

  it('patching anchor validates clipId, sets it, and clears start', async () => {
    const store = await storeWithOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_abs',
      patch: { anchor: { clipId: 'c1', offset: 0.5 } },
    });
    expect(r.ok).toBe(true);
    const o = store.doc.tracks.overlays[0]!;
    expect(o.anchor).toEqual({ clipId: 'c1', offset: 0.5 });
    expect(o.start).toBeUndefined();
  });

  it('rejects anchor with unknown clipId', async () => {
    const store = await storeWithOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_abs',
      patch: { anchor: { clipId: 'nope', offset: 0 } },
    });
    expect(r.ok).toBe(false);
  });

  it('patching start on an anchored overlay converts it to absolute (clears anchor)', async () => {
    const store = await storeWithOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_anc',
      patch: { start: 4 },
    });
    expect(r.ok).toBe(true);
    const o = store.doc.tracks.overlays[1]!;
    expect(o.start).toBe(4);
    // 沒有這條互斥規則時 anchor 會留著且優先生效 → 設 start 看似成功實際無效
    expect(o.anchor).toBeUndefined();
  });
});

// CaptionToken 的時間是**時間軸絕對秒數**，不是相對句首的偏移。
// 整句平移（拖曳）必須連同 tokens 一起移，否則預覽依新 start 顯示、匯出的逐詞字卡卻還在
// 舊時間出現；但修邊（trim）**絕不能**動 tokens——時間軸左把手是 trim-in（右緣釘住、
// start 往後、duration 等量縮短），把它當平移會把整條 karaoke 從語音上扯開。
describe('updateCaption：平移 tokens 跟著動、修邊 tokens 不動', () => {
  // 詞相對句首 +0.2 起、每詞 0.6 長；句子 start=10 duration=3（end=13）。
  // 用這組數字是因為「reviewer 實測的 trim-in」正好會把最後一個詞推出句尾（13.3 > 13），
  // render.ts 的 renderCaptionCards 會因此把它的高亮視窗夾掉一半。
  const SEED = () => [
    { text: 'a', start: 10.2, end: 10.8 },
    { text: 'b', start: 11.2, end: 11.8 },
    { text: 'c', start: 12.4, end: 13.0 },
  ];
  async function storeWithKaraoke() {
    const store = await storeWithClips();
    store.mutate('ai', 'seed karaoke', (d) => {
      d.tracks.captions = [
        {
          id: 'kar',
          text: 'a b c',
          start: 10,
          duration: 3,
          style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
          tokens: SEED(),
        },
      ];
    });
    return store;
  }
  // 取到小數 6 位再比：平移是浮點加法（10.2 − 0.9 = 10.299999999999999）。
  // 6 位仍遠小於任何有意義的位移（測資的差距都在 0.1 秒以上），符號/大小錯了照樣抓得到。
  const round6 = (n: number) => Number(n.toFixed(6));
  const times = (store: Awaited<ReturnType<typeof storeWithKaraoke>>) =>
    store.doc.tracks.captions[0]!.tokens!.map((t) => [round6(t.start), round6(t.end)]);

  // ── 平移（rigid translation）：兩端位移相同 ────────────────────────────────
  // 斷言寫死絕對值：符號寫反會得到完全不同的數字，「tokens 有變」這種弱斷言抓不到。

  it('往後拖 +1.5s（只給 start）：每個詞 +1.5', async () => {
    const store = await storeWithKaraoke();
    const r = applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'kar',
      patch: { start: 11.5 },
    });
    expect(r.ok).toBe(true);
    expect(times(store)).toEqual([
      [11.7, 12.3],
      [12.7, 13.3],
      [13.9, 14.5],
    ]);
  });

  it('往前拖 −0.9s（只給 start）：每個詞 −0.9（符號寫反會得到 +0.9 的那組數字）', async () => {
    const store = await storeWithKaraoke();
    applyCommand(store, 'human', { name: 'updateCaption', id: 'kar', patch: { start: 9.1 } });
    const t = times(store);
    expect(t).toEqual([
      [9.3, 9.9],
      [10.3, 10.9],
      [11.5, 12.1],
    ]);
    // 同時證明「不是往另一個方向移」：符號寫反的話第一個詞會是 11.1。
    expect(t[0]![0]).toBeLessThan(10.2);
  });

  it('時間軸拖曳實際送的形狀 {start, duration} 且 duration 不變 → 仍算平移', async () => {
    // Timeline.tsx 的 edge:'move' 一律把 start 與 duration 兩個都送出來（duration 原封不動）。
    // 判斷規則若寫成「有給 duration 就當修邊」，真正的拖曳會整個失效——這條擋住那種寫法。
    const store = await storeWithKaraoke();
    applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'kar',
      patch: { start: 12, duration: 3 },
    });
    expect(times(store)).toEqual([
      [12.2, 12.8],
      [13.2, 13.8],
      [14.4, 15.0],
    ]);
  });

  // ── 修邊（trim）：只動一邊，詞時間必須原封不動 ───────────────────────────

  it('左把手 trim-in 縮短（start 10→10.5、duration 3→2.5，右緣釘在 13）：tokens 完全不動', async () => {
    const store = await storeWithKaraoke();
    const r = applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'kar',
      patch: { start: 10.5, duration: 2.5 },
    });
    expect(r.ok).toBe(true);
    const c = store.doc.tracks.captions[0]!;
    expect(c.start).toBe(10.5);
    expect(c.duration).toBe(2.5);
    expect(times(store)).toEqual([
      [10.2, 10.8],
      [11.2, 11.8],
      [12.4, 13.0],
    ]);
    // 這就是 bug 的可觀測後果：平移版本會把最後一個詞推到 13.3，超出句尾 13，
    // renderCaptionCards 於是把它的高亮視窗夾掉一半。
    const end = c.start + c.duration;
    expect(c.tokens!.at(-1)!.end).toBeLessThanOrEqual(end + 1e-9);
  });

  it('左把手 trim-in 反方向（往左拉長：start 10→9.5、duration 3→3.5）：tokens 一樣不動', async () => {
    const store = await storeWithKaraoke();
    applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'kar',
      patch: { start: 9.5, duration: 3.5 },
    });
    expect(store.doc.tracks.captions[0]!.start).toBe(9.5);
    expect(times(store)).toEqual([
      [10.2, 10.8],
      [11.2, 11.8],
      [12.4, 13.0],
    ]);
  });

  it('右把手 trim-out（只給 duration，start 不變）：tokens 不動', async () => {
    const store = await storeWithKaraoke();
    applyCommand(store, 'human', { name: 'updateCaption', id: 'kar', patch: { duration: 5 } });
    expect(store.doc.tracks.captions[0]!.duration).toBe(5);
    expect(times(store)).toEqual(SEED().map((t) => [t.start, t.end]));
  });

  it('右把手 trim-out 但把 start 一起原值送出（delta=0）：tokens 不動', async () => {
    const store = await storeWithKaraoke();
    applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'kar',
      patch: { start: 10, duration: 2 },
    });
    expect(times(store)).toEqual(SEED().map((t) => [t.start, t.end]));
  });

  // ── 其他邊界 ───────────────────────────────────────────────────────────────

  it('同一次呼叫也給了 tokens：以呼叫端給的為準，不得再平移一次（雙倍位移）', async () => {
    const store = await storeWithKaraoke();
    applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'kar',
      patch: {
        start: 11.5, // delta = +1.5；呼叫端給的 tokens 不可以再被加一次
        tokens: [
          { text: 'a', start: 0.5, end: 1.0 },
          { text: 'b', start: 1.0, end: 1.5 },
        ],
      },
    });
    // 寫死期望值，不能拿傳進去的那個陣列來比對——immer 會把「指派進 draft 的原生物件」
    // 就地 mutate，拿它當期望值等於自己跟自己比，怎樣都會過（這個坑本次真的踩到過）。
    expect(store.doc.tracks.captions[0]!.tokens).toEqual([
      { text: 'a', start: 0.5, end: 1.0 },
      { text: 'b', start: 1.0, end: 1.5 },
    ]);
  });

  it('沒有 tokens 的字幕平移：不會炸，也不會生出 tokens', async () => {
    const plain = await storeWithClips(); // cap1 沒有 tokens
    const r = applyCommand(plain, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { start: 5 },
    });
    expect(r.ok).toBe(true);
    expect(plain.doc.tracks.captions[0]!.start).toBe(5);
    expect(plain.doc.tracks.captions[0]!.tokens).toBeUndefined();
  });
});

// 純圖 overlay（外部腳本產的排名徽章之類）送 patch.text 曾經會被靜默轉成文字卡，
// 把使用者的 imagePath 覆蓋掉且回 ok:true——只有 undo 救得回來。命令層要擋住。
describe('updateOverlay 不得把純圖 overlay 轉成文字 overlay', () => {
  const TEXT = { text: '被塞進來的字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' };

  async function storeWithMixedOverlays() {
    const store = await storeWithClips();
    store.mutate('ai', 'seed overlays', (d) => {
      d.tracks.overlays = [
        // 純圖：沒有 text 欄位
        {
          id: 'ov_png',
          imagePath: 'assets/rank_ov_0.png',
          start: 0,
          duration: 3,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
        // 文字 overlay：一開始就有 text
        {
          id: 'ov_text',
          imagePath: 'derived/text/aaaaaaaaaaaaaaaa.base.png',
          text: { text: '原標題', fontFamily: 'Heiti TC', fontSize: 72, fill: '#ffffff' },
          start: 0,
          duration: 3,
          position: { x: 0.5, y: 0.4, scale: 1 },
        },
      ];
    });
    return store;
  }

  it('對純圖 overlay 送 patch.text（連同已產好的 imagePath）被拒，原 imagePath 零損傷、版本不動', async () => {
    const store = await storeWithMixedOverlays();
    const beforeVersion = store.version;
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_png',
      // 這正是 resolveTextCommand 前置跑完之後會送進來的形狀：text + 一張真的產好的卡。
      // 沒有「目標必須本來就是文字 overlay」這道檢查的話，下面兩個斷言都會失敗
      // （imagePath 會被換成字卡、text 會被塞進去）。
      patch: { text: TEXT, imagePath: 'derived/text/bbbbbbbbbbbbbbbb.base.png' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('ov_png');
    const o = store.doc.tracks.overlays.find((x) => x.id === 'ov_png')!;
    expect(o.imagePath).toBe('assets/rank_ov_0.png');
    expect(o.text).toBeUndefined();
    expect(store.version).toBe(beforeVersion);
  });

  it('對本來就是文字 overlay 的項目照常成功（不是一律拒絕 patch.text）', async () => {
    const store = await storeWithMixedOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_text',
      patch: { text: TEXT, imagePath: 'derived/text/bbbbbbbbbbbbbbbb.base.png' },
    });
    expect(r.ok).toBe(true);
    const o = store.doc.tracks.overlays.find((x) => x.id === 'ov_text')!;
    expect(o.text?.text).toBe('被塞進來的字');
    expect(o.imagePath).toBe('derived/text/bbbbbbbbbbbbbbbb.base.png');
  });

  it('純圖 overlay 的其他欄位（start/position）照樣可以改', async () => {
    const store = await storeWithMixedOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_png',
      patch: { start: 1.25 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.overlays.find((x) => x.id === 'ov_png')!.start).toBe(1.25);
  });
});

describe('addOverlay / removeOverlay', () => {
  it('appends a valid overlay', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: {
        id: 'ov_new',
        imagePath: 'assets/t.png',
        start: 2,
        duration: 3,
        position: { x: 0.5, y: 0.1, scale: 1 },
      },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.overlays.map((o) => o.id)).toContain('ov_new');
  });

  it('rejects overlay without start or anchor, or with bad duration', async () => {
    const store = await storeWithClips();
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'x1',
          imagePath: 'a.png',
          duration: 3,
          position: { x: 0, y: 0, scale: 1 },
        },
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'x2',
          imagePath: 'a.png',
          start: 0,
          duration: 0,
          position: { x: 0, y: 0, scale: 1 },
        },
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'x3',
          imagePath: 'a.png',
          anchor: { clipId: 'nope', offset: 0 },
          duration: null,
          position: { x: 0, y: 0, scale: 1 },
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects duplicate overlay id', async () => {
    const store = await storeWithClips();
    const overlay = {
      id: 'dup',
      imagePath: 'a.png',
      start: 0,
      duration: null,
      position: { x: 0, y: 0, scale: 1 },
    };
    expect(applyCommand(store, 'human', { name: 'addOverlay', overlay }).ok).toBe(true);
    expect(applyCommand(store, 'human', { name: 'addOverlay', overlay }).ok).toBe(false);
  });

  it('removeOverlay removes existing and rejects missing', async () => {
    const store = await storeWithClips();
    applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: {
        id: 'ov_rm',
        imagePath: 'a.png',
        start: 0,
        duration: 2,
        position: { x: 0, y: 0, scale: 1 },
      },
    });
    expect(applyCommand(store, 'human', { name: 'removeOverlay', id: 'ov_rm' }).ok).toBe(true);
    expect(store.doc.tracks.overlays.some((o) => o.id === 'ov_rm')).toBe(false);
    expect(applyCommand(store, 'human', { name: 'removeOverlay', id: 'ov_rm' }).ok).toBe(false);
  });
});

// text_card.py 的無 tokens 路徑**完全不換行**（只 split("\n")），所以卡的高度是由行數驅動的。
// 只限制「text ≤ 4000 字」等於允許 4000 行：實測那個 payload 是 10 Gpx / 40 GB RGBA / 約 17 分鐘，
// 而且以前只有 HTTP 預覽端點擋，會**寫進文件**的這兩條路（字幕、文字 overlay）完全沒擋——
// 落盤之後每次載入、每次 cardSync 都會再引爆一次。
describe('會落盤的產卡路徑要吃像素預算（命令層拒絕，不是丟例外）', () => {
  const STYLE = { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff', y: 0.8 };
  const cap = (over: Record<string, unknown>) => ({
    id: 'boom',
    text: 'ok',
    start: 0,
    duration: 2,
    style: STYLE,
    ...over,
  });

  it('setCaptions：4000 行的字幕被拒，文件與版本完全不動', async () => {
    const store = await storeWithClips();
    const before = store.version;
    const captionsBefore = store.doc.tracks.captions;
    const r = applyCommand(store, 'human', {
      name: 'setCaptions',
      captions: [cap({ text: '\n'.repeat(4000) })],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/too large/);
    expect(r.ok === false && r.error).toMatch(/boom/); // 錯誤訊息指出是哪一句
    expect(store.version).toBe(before);
    expect(store.doc.tracks.captions).toBe(captionsBefore);
  });

  it('setCaptions：荒謬字級（fontSize 20000，schema 之外的路徑）被拒', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setCaptions',
      captions: [cap({ style: { ...STYLE, fontSize: 20000 } })],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/fontSize/);
  });

  it('setCaptions：正常字幕照樣通過（預算沒有訂得太緊）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setCaptions',
      captions: [cap({ text: '這是一句正常長度的字幕' })],
    });
    expect(r.ok).toBe(true);
  });

  it('setCaptions：整批中只要一句超標就整批拒絕（其他句也不得寫入）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setCaptions',
      captions: [cap({ id: 'good', text: '正常' }), cap({ id: 'bad', text: '\n'.repeat(4000) })],
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.captions.some((c) => c.id === 'good')).toBe(false);
  });

  it('updateCaption：把既有字幕改成超標的字級/內容 → 拒絕，原字幕不動', async () => {
    const store = await storeWithClips();
    const before = store.doc.tracks.captions[0]!.style.fontSize;
    const r = applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { style: { ...STYLE, fontSize: 5000 } },
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.captions[0]!.style.fontSize).toBe(before);

    const r2 = applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { text: '\n'.repeat(4000) },
    });
    expect(r2.ok).toBe(false);
    expect(store.doc.tracks.captions[0]!.text).toBe('hi');
  });

  it('updateCaption：改 start/duration 不受預算檢查影響（那兩個欄位不影響排版）', async () => {
    const store = await storeWithClips();
    expect(
      applyCommand(store, 'human', { name: 'updateCaption', id: 'cap1', patch: { start: 4 } }).ok,
    ).toBe(true);
  });

  it('addOverlay：超標的文字 overlay 被拒，且錯誤講的是「太大」而不是誤導的 (server error)', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: {
        id: 'ov_boom',
        imagePath: '', // 超標時 resolveTextCommand 刻意不產卡，所以這裡會是空的
        // 前面補一個真的字：純換行會先被「不得空白」那條規則擋掉，測不到預算這條。
        text: {
          text: `標題${'\n'.repeat(3000)}`,
          fontFamily: 'Heiti TC',
          fontSize: 64,
          fill: '#ffffff',
        },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.1, scale: 1 },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/too large/);
    expect(r.ok === false && r.error).not.toMatch(/server error/);
    expect(store.doc.tracks.overlays).toHaveLength(0);
  });

  it('setOverlays：同一套規則（整組替換不因為是整組就放寬）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setOverlays',
      overlays: [
        {
          id: 'ov_boom',
          imagePath: '',
          text: { text: 'x', fontFamily: 'Heiti TC', fontSize: 9999, fill: '#ffffff' },
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/fontSize/);
  });
});

// ---- 命令層的數值健檢（2026-08-04）------------------------------------------
//
// 這一組守的是「壞數字寫進 project.json」這條路。壞值的來源不是假想敵：
// - `JSON.stringify(NaN)` / `JSON.stringify(Infinity)` 都是 **null**，所以任何算出 NaN
//   的呼叫端（Player 的拖曳在 stageW 還沒量到時就會，那裡因此加了保險絲）送到伺服器時
//   長得像 `null`；而 WS 通道沒有任何 schema（wsHub 是 `JSON.parse(...) as WsClientMsg`）。
// - NaN 跟任何值比較都是 false，所以命令層既有的 `duration <= 0`、`in < 0` 這類檢查
//   對它**完全沒作用**——不是擋得不夠嚴，是根本沒擋。
// 症狀會延到 render 才爆（ffmpeg 濾鏡運算式壞掉），離成因很遠，所以擋在寫入前。
describe('applyCommand 的數值健檢', () => {
  async function storeWithEverything() {
    const store = await storeWithClips();
    store.mutate('ai', 'seed2', (d) => {
      d.tracks.overlays = [
        {
          id: 'ov1',
          imagePath: 'assets/a.png',
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
      ];
      d.tracks.audio = [{ id: 'a1', mediaId: 'm1', start: 0, in: 0, duration: 3, volume: 1 }];
    });
    return store;
  }
  /** 壞值要繞過型別（型別本來就說是 number；擋的是**執行期**送進來的東西）。 */
  const bad = (v: unknown): number => v as number;

  // JSON 傳不了 NaN/Infinity，落到線上的形狀就是 null；三種都要擋。
  const BAD_VALUES: Array<[string, unknown]> = [
    ['null（NaN/Infinity 序列化後的樣子）', null],
    ['NaN（同程序內呼叫）', NaN],
    ['Infinity', Infinity],
  ];

  for (const [label, v] of BAD_VALUES) {
    it(`updateOverlay position.x = ${label} → 拒絕、指名欄位、文件不動`, async () => {
      const store = await storeWithEverything();
      const before = store.version;
      const r = applyCommand(store, 'human', {
        name: 'updateOverlay',
        id: 'ov1',
        patch: { position: { x: bad(v), y: 0.1, scale: 1 } },
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/patch\.position\.x must be a finite number/);
      expect(store.doc.tracks.overlays[0]!.position.x).toBe(0.5); // 沒被寫進去
      expect(store.version).toBe(before); // 也沒有多出一個版本／undo 步驟
    });
  }

  /**
   * setTimeline 2026-08-05 才從「MCP 工具自己 store.mutate」搬進命令層，數值健檢因此
   * 第一次涵蓋得到它。這條**必須打 applyCommand 而不是 MCP 工具**：
   *
   * - MCP 那條路的 zod `z.number()` 本來就擋掉 NaN/null，所以從那裡永遠測不到這道檢查。
   * - 而 `setTimeline` 自己的邊界檢查擋不住 NaN——`NaN <= 0`、`NaN > 素材長度` **全是
   *   false**，整個檢查等於不存在，壞值會直接落盤（`JSON.stringify(NaN)` 是 `null`，
   *   之後每次載入都壞，症狀要到 render 時才以看不懂的 ffmpeg 濾鏡式子冒出來）。
   * - Infinity 反而會被邊界檢查擋下（`Infinity > 20` 為真），所以拿它測不出差別。
   *
   * setTimeline 現在也在 `Command` 裡，wsHub 是 `JSON.parse(data) as WsClientMsg` 直接餵
   * 進 applyCommand——這條保護的就是那一段。
   */
  for (const [label, v] of BAD_VALUES) {
    it(`setTimeline clips[0].duration = ${label} → 拒絕、指名欄位、主軌不動`, async () => {
      const store = await storeWithEverything();
      const before = store.doc.tracks.video.map((c) => c.id);
      const r = applyCommand(store, 'human', {
        name: 'setTimeline',
        clips: [{ mediaId: 'm1', in: 0, duration: bad(v) }],
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/clips\[0\]\.duration must be a finite number/);
      expect(store.doc.tracks.video.map((c) => c.id)).toEqual(before);
    });
  }

  // ⚠️ 這條是**反向**保護：position 早就不限定 0–1（元素可以掛在畫布外，
  // 見 OverlayItem.position 的註解），把範圍檢查誤加進來會是回歸。
  it('畫布外的合法位置照樣放行（不是把 0–1 夾制偷渡進來）', async () => {
    const store = await storeWithEverything();
    for (const p of [
      { x: -0.5, y: -0.2, scale: 1 },
      { x: 1.8, y: 2.5, scale: 1 },
      { x: -1000, y: 1000, scale: 1 },
      { x: 0.5, y: 0.1, scale: 0 }, // 0 ＝「看不見」，預覽與成品一致，是明講的行為
    ]) {
      const r = applyCommand(store, 'human', {
        name: 'updateOverlay',
        id: 'ov1',
        patch: { position: p },
      });
      expect(r.ok, `${JSON.stringify(p)} 應該放行`).toBe(true);
      expect(store.doc.tracks.overlays[0]!.position).toEqual(p);
    }
  });

  it('scale 負值與過大值被擋（負值＝預覽鏡像／成品整張消失的落差；過大＝記憶體炸彈）', async () => {
    const store = await storeWithEverything();
    for (const s of [-1, -0.001, 10.5, 1e6]) {
      const r = applyCommand(store, 'human', {
        name: 'updateOverlay',
        id: 'ov1',
        patch: { position: { x: 0.5, y: 0.1, scale: s } },
      });
      expect(r.ok, `scale ${s} 應該被擋`).toBe(false);
      expect(r.ok === false && r.error).toMatch(/patch\.position\.scale must be within/);
    }
    // 邊界內側仍然可用
    expect(
      applyCommand(store, 'human', {
        name: 'updateOverlay',
        id: 'ov1',
        patch: { position: { x: 0.5, y: 0.1, scale: 10 } },
      }).ok,
    ).toBe(true);
  });

  it('addOverlay 缺 position 或 position 是 null → 拒絕（render 會直接讀 position.x）', async () => {
    const store = await storeWithEverything();
    const base = { id: 'ov_np', imagePath: 'a.png', start: 0, duration: 1 };
    const r1 = applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: base as unknown as (typeof store.doc.tracks.overlays)[number],
    });
    expect(r1.ok).toBe(false);
    expect(r1.ok === false && r1.error).toMatch(/overlay\.position is required/);
    const r2 = applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: { ...base, position: null } as unknown as (typeof store.doc.tracks.overlays)[number],
    });
    expect(r2.ok).toBe(false);
    expect(store.doc.tracks.overlays).toHaveLength(1);
  });

  it('setOverlays：整組裡有一個壞的就整批拒絕、指名是第幾個', async () => {
    const store = await storeWithEverything();
    const good = {
      id: 'g',
      imagePath: 'a.png',
      start: 0,
      duration: 1,
      position: { x: 0.5, y: 0, scale: 1 },
    };
    const r = applyCommand(store, 'human', {
      name: 'setOverlays',
      overlays: [good, { ...good, id: 'b', position: { x: 0.5, y: bad(null), scale: 1 } }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/overlays\[1\]\.position\.y must be a finite number/);
    expect(store.doc.tracks.overlays.map((o) => o.id)).toEqual(['ov1']); // 整批沒進去
  });

  it('overlay duration: null（＝到片尾）不是壞值', async () => {
    const store = await storeWithEverything();
    expect(
      applyCommand(store, 'human', { name: 'updateOverlay', id: 'ov1', patch: { duration: null } })
        .ok,
    ).toBe(true);
  });

  it('anchor.offset 壞掉 → 拒絕（overlayWindow 會拿它去算絕對時間）', async () => {
    const store = await storeWithEverything();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov1',
      patch: { anchor: { clipId: 'c1', offset: bad(null) } },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/patch\.anchor\.offset/);
  });

  it('updateClip：NaN 進不了 in/duration/volume（既有的 <0 檢查對 NaN 完全沒作用）', async () => {
    const store = await storeWithEverything();
    for (const patch of [{ in: NaN }, { duration: NaN }, { volume: bad(null) }]) {
      const r = applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch });
      expect(r.ok, `${JSON.stringify(patch)} 應該被擋`).toBe(false);
    }
    expect(store.doc.tracks.video[0]!.in).toBe(2);
    expect(store.doc.tracks.video[0]!.duration).toBe(5);
  });

  it('updateCaption：style.y 壞掉 → 拒絕（cardBudget 只管 fontSize，y 沒有人驗）', async () => {
    const store = await storeWithEverything();
    const r = applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: bad(null) } },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/patch\.style\.y must be a finite number/);
    expect(store.doc.tracks.captions[0]!.style.y).toBe(0.8);
  });

  it('updateCaption：start / duration / tokens 的時間戳也擋', async () => {
    const store = await storeWithEverything();
    expect(
      applyCommand(store, 'human', { name: 'updateCaption', id: 'cap1', patch: { start: NaN } }).ok,
    ).toBe(false);
    const r = applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { tokens: [{ text: 'a', start: 0, end: bad(null) }] },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/patch\.tokens\[0\]\.end/);
  });

  it('setCaptions：整批裡一句壞掉就整批拒絕（跟像素預算同一個原則）', async () => {
    const store = await storeWithEverything();
    const style = { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 };
    const r = applyCommand(store, 'human', {
      name: 'setCaptions',
      captions: [
        { id: 'n1', text: 'a', start: 0, duration: 1, style },
        { id: 'n2', text: 'b', start: bad(null), duration: 1, style },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/captions\[1\]\.start/);
    expect(store.doc.tracks.captions.map((c) => c.id)).toEqual(['cap1']);
  });

  it('setAudio / updateAudio：音訊軌本來完全沒有數值驗證（setAudio 直接整組覆蓋）', async () => {
    const store = await storeWithEverything();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [{ id: 'x', mediaId: 'm1', start: 0, in: 0, duration: bad(Infinity), volume: 1 }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/audio\[0\]\.duration/);
    expect(store.doc.tracks.audio.map((a) => a.id)).toEqual(['a1']);

    // updateAudio 是 Object.assign(item, patch)：patch 裡的壞值會原封不動蓋進文件
    const r2 = applyCommand(store, 'human', {
      name: 'updateAudio',
      id: 'a1',
      patch: { volume: NaN },
    });
    expect(r2.ok).toBe(false);
    expect(store.doc.tracks.audio[0]!.volume).toBe(1);
  });

  it('時間軸操作：splitAt / deleteBefore / freezeFrame 的 time 與 duration', async () => {
    const store = await storeWithEverything();
    expect(applyCommand(store, 'human', { name: 'splitAt', time: NaN }).ok).toBe(false);
    // deleteBefore(NaN) 以前會通過所有比較、把「全部保留」寫成一個新版本（靜默 no-op mutation）
    const before = store.version;
    const r = applyCommand(store, 'human', { name: 'deleteBefore', time: bad(null) });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/^time must be a finite number/);
    expect(store.version).toBe(before);
    // freezeFrame(duration: NaN) 以前會插入一個 duration = NaN 的片段
    const r2 = applyCommand(store, 'human', { name: 'freezeFrame', time: 1, duration: NaN });
    expect(r2.ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(2);
  });
});

describe('addClip', () => {
  it('append 到主軌尾端', async () => {
    const store = await storeWithClips();
    const before = store.doc.tracks.video.length;
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 3 });
    expect(r.ok).toBe(true);
    const clips = store.doc.tracks.video;
    expect(clips).toHaveLength(before + 1);
    expect(clips[clips.length - 1]).toMatchObject({ mediaId: 'm1', in: 0, duration: 3, volume: 1 });
    expect(clips[clips.length - 1]!.id).toBeTruthy();
  });

  it('未知 mediaId 被拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'addClip',
      mediaId: 'nope',
      in: 0,
      duration: 3,
    });
    expect(r.ok).toBe(false);
  });

  it('duration <= 0 被拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 0 });
    expect(r.ok).toBe(false);
  });

  it('in + duration 超出素材長度被拒絕', async () => {
    const store = await storeWithClips();
    // m1 全長 20 秒
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 18, duration: 5 });
    expect(r.ok).toBe(false);
  });

  it('剛好用滿素材長度是允許的', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 20 });
    expect(r.ok).toBe(true);
  });

  it('負的 in 被拒絕（in=-1, duration=1 若無此守衛，-1+1=0 不會超界，會通過並讓 ffmpeg 收到 -ss -1）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: -1, duration: 1 });
    expect(r.ok).toBe(false);
  });

  // 合併 main（純音訊可 ingest）後才成立的守衛：MCP 的 set_timeline 擋得住
  // audio-only（mcp.ts:334），但 addClip 是本分支新增的第二條上視訊軌的路，
  // 且 POST /api/import 的 addToTimeline 直接呼叫它——沒這道守衛，匯入一支 .mp3
  // 就會把純音訊素材放上視訊軌，渲染時 ffmpeg 才炸。
  it('純音訊素材（hasVideo:false）不得加上視訊軌', async () => {
    const store = await storeWithClips();
    store.mutate('ai', 'seed audio-only', (d) => {
      d.media.push({
        id: 'bgm',
        path: '/outside/bgm.mp3',
        probe: {
          duration: 30,
          width: 0,
          height: 0,
          fps: 30,
          hasAudio: true,
          rotation: 0,
          hasVideo: false,
        },
      });
    });
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'bgm', in: 0, duration: 5 });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.video.some((c) => c.mediaId === 'bgm')).toBe(false);
  });

  it('浮點誤差導致的邊界：1e-6 容差保護', async () => {
    const store = await storeWithClips();
    // duration = 20 + 1e-7 = 20.0000001
    // 總和 (in=0) 略大於素材長度（20），但差異 (1e-7) < 1e-6，應被容差允許。
    // 若容差被拿掉（+0），測試會因為 20.0000001 > 20 而變紅。
    const duration = 20 + 1e-7;
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration });
    expect(r.ok).toBe(true);
  });
});

// setAudio 原本零驗證（d.tracks.audio = cmd.audio），與 addClip 的五道守衛不對稱。
// 實測後果：AI 抄錯一個 8 字元 mediaId → 被接受 → 落盤 → 重啟後 undo 堆疊已失效
// （「nothing to undo」）→ 直到 render 才丟 "media not found for audio"。
describe('setAudio 驗證', () => {
  // 型別化的 helper：patch 用 Partial<AudioItem> 而非 Record<string, unknown>，
  // 這樣每個測試都不需要 as never 轉型——'NOPE' 是合法的 string，型別上過得去，
  // 執行期才該被新驗證擋下，正好是我們要測的東西。
  const item = (patch: Partial<AudioItem> = {}): AudioItem => ({
    id: 'a1',
    mediaId: 'm1',
    start: 0,
    in: 0,
    duration: 5,
    volume: 1,
    ...patch,
  });

  it('mediaId 不存在 → 拒絕，且音訊軌維持原樣（不得半套寫入）', async () => {
    const store = await storeWithClips();
    store.mutate('ai', 'seed audio', (d) => {
      d.tracks.audio = [item()];
    });
    const before = structuredClone(store.doc.tracks.audio);
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ id: 'a2', mediaId: 'NOPE' })],
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.audio).toEqual(before);
  });

  it('duration <= 0 → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ duration: 0 })],
    });
    expect(r.ok).toBe(false);
  });

  it('負的 in → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ in: -1, duration: 1 })],
    });
    expect(r.ok).toBe(false);
  });

  it('in + duration 超過素材長度 → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ in: 18, duration: 5 })],
    });
    expect(r.ok).toBe(false);
  });

  it('剛好用滿素材長度是允許的（1e-6 容差，與 addClip 一致）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ in: 0, duration: 20 })],
    });
    expect(r.ok).toBe(true);
  });

  it('多個 item 其中一個壞 → 整批拒，音訊軌維持原樣', async () => {
    const store = await storeWithClips();
    const before = structuredClone(store.doc.tracks.audio);
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item(), item({ id: 'a2', mediaId: 'NOPE' })],
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.audio).toEqual(before);
  });

  // 迴歸護甲：audio: [] 是清空音訊軌的慣用法（mcp-tools.test.ts:174 正在用）。
  // 新驗證若寫成「必須非空」就會打破它——這是本 Task 最容易做錯的地方。
  it('audio: [] 清空音訊軌（既有行為，不得因新驗證而破壞）', async () => {
    const store = await storeWithClips();
    store.mutate('ai', 'seed audio', (d) => {
      d.tracks.audio = [item()];
    });
    const r = applyCommand(store, 'human', { name: 'setAudio', audio: [] });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.audio).toEqual([]);
  });
});

// updateMediaDerived：background ingest（A1 filmstrip/peaks、A2 proxy）寫回 derived 欄位
// 的唯一管道，與 registerMedia 同一種「內部命令」定位——見 commands.ts 的豁免註解。
describe('updateMediaDerived', () => {
  it('合法更新：逐欄可選，寫進 doc', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: {
        proxyPath: 'media/m1/proxy.mp4',
        filmstripPath: 'media/m1/filmstrip.jpg',
        filmstripTiles: 12,
        peaksPath: 'media/m1/peaks.json',
      },
    });
    expect(r.ok).toBe(true);
    const m1 = store.doc.media.find((m) => m.id === 'm1');
    expect(m1).toMatchObject({
      proxyPath: 'media/m1/proxy.mp4',
      filmstripPath: 'media/m1/filmstrip.jpg',
      filmstripTiles: 12,
      peaksPath: 'media/m1/peaks.json',
    });
  });

  it('只帶單一欄位也合法（部分完成的階段先寫入）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { peaksPath: 'media/m1/peaks.json' },
    });
    expect(r.ok).toBe(true);
    const m1 = store.doc.media.find((m) => m.id === 'm1');
    expect(m1?.peaksPath).toBe('media/m1/peaks.json');
    expect(m1?.proxyPath).toBeUndefined();
  });

  it('未提供的欄位不得覆蓋既有值', async () => {
    const store = await storeWithClips();
    applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { proxyPath: 'media/m1/proxy.mp4', peaksPath: 'media/m1/peaks.json' },
    });
    // 第二次只更新 filmstripPath，前一次寫入的 proxyPath/peaksPath 應維持不變
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripPath: 'media/m1/filmstrip.jpg', filmstripTiles: 8 },
    });
    expect(r.ok).toBe(true);
    const m1 = store.doc.media.find((m) => m.id === 'm1');
    expect(m1).toMatchObject({
      proxyPath: 'media/m1/proxy.mp4',
      peaksPath: 'media/m1/peaks.json',
      filmstripPath: 'media/m1/filmstrip.jpg',
      filmstripTiles: 8,
    });
  });

  it('mediaId 不存在 → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'nope',
      patch: { peaksPath: 'media/nope/peaks.json' },
    });
    expect(r.ok).toBe(false);
  });

  it('路徑帶 .. → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { proxyPath: '../outside/proxy.mp4' },
    });
    expect(r.ok).toBe(false);
    expect(store.doc.media.find((m) => m.id === 'm1')?.proxyPath).toBeUndefined();
  });

  it('絕對路徑 → 拒絕（derived 檔一律專案內相對路徑，與 asset.path 的零複製匯入語意不同）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripPath: '/etc/passwd' },
    });
    expect(r.ok).toBe(false);
    expect(store.doc.media.find((m) => m.id === 'm1')?.filmstripPath).toBeUndefined();
  });

  it('filmstripTiles 非正整數 → 拒絕（0）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripTiles: 0 },
    });
    expect(r.ok).toBe(false);
  });

  it('filmstripTiles 非正整數 → 拒絕（負數）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripTiles: -1 },
    });
    expect(r.ok).toBe(false);
  });

  it('filmstripTiles 非整數 → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripTiles: 1.5 },
    });
    expect(r.ok).toBe(false);
  });

  it('驗證失敗時整批不寫入（不得半套）', async () => {
    const store = await storeWithClips();
    const before = structuredClone(store.doc.media.find((m) => m.id === 'm1'));
    const r = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { peaksPath: 'media/m1/peaks.json', filmstripTiles: -1 },
    });
    expect(r.ok).toBe(false);
    expect(store.doc.media.find((m) => m.id === 'm1')).toEqual(before);
  });
});
