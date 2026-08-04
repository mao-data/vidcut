import { describe, it, expect } from 'vitest';
import { dragOverlay, dragCaption } from './dragLayer.js';

const CANVAS = { w: 1080, h: 1920 };

describe('dragOverlay', () => {
  it('位移換算 position；錨點不對稱正確（x 中心/y 上緣）', () => {
    // 起點 {0.5, 0.4}，bbox 400×100，拖 +108px/-192px
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 108, dy: -192 }, { w: 400, h: 100 }, CANVAS);
    // 未觸發吸附時：x = 0.5+0.1 = 0.6, y = 0.4-0.1 = 0.3
    expect(r.position.x).toBeCloseTo(0.6);
    expect(r.position.y).toBeCloseTo(0.3);
  });
  it('拖近水平中心會吸回 0.5 並給導線', () => {
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 10, dy: 0 }, { w: 400, h: 100 }, CANVAS);
    expect(r.position.x).toBeCloseTo(0.5);
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true);
  });

  it('抓住吸附時的錨點不對稱驗證：y 用上緣錨定，不是中心錨定', () => {
    // startPos.y=0.4（上緣=768px），bbox h=200，dy=+97 → 上緣=865px，離「垂直中心」候選
    // （cy-h/2 = 960-100 = 860px）只差 5px，落在 16px 吸附半徑內 → 觸發吸附、位移量不再
    // 只是「起點+delta」的線性關係，encode/decode 的 h/2 offset 不會互相抵銷。
    // 若誤用「中心錨定」的編碼/解碼（encode 先減 bbox.h/2、decode 再加回），起點會被誤判成
    // 「中心在 0.4」，raw 上緣就會多減一個 h/2 變成 765px——離同一個候選 95px，超出吸附
    // 半徑，根本不會吸附；即使不看吸附有沒有觸發，最終 position.y 兩者也會明顯不同
    // （860/1920 vs 865/1920）。這個案例特別選在「吸附半徑邊界」，讓兩種實作分道揚鑣——
    // 不像「未觸發吸附」的案例，encode 的 -h/2 與 decode 的 +h/2 會直接互相抵銷，
    // 對稱與不對稱兩種寫法在那種案例下算出來的數字會一樣，測不出差異。
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 0, dy: 97 }, { w: 400, h: 200 }, CANVAS);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 960 });
    expect(r.position.y).toBeCloseTo(860 / 1920, 6);
  });

  it('大位移往下拖不會把元素整個推出畫布下緣（上限＝中心貼齊畫布下緣）', () => {
    // y 錨=上緣：clamp 到 1 代表上緣頂到畫布最底端＝整個元素 100% 掉出畫面
    // （shared/src/snap.ts:5-8 記錄過的事故正是這個誤解）。
    // 2026-08-04 起規則放寬成「中心留在畫布內」（使用者要求四邊都能超出），
    // 所以上限從「上緣最多 canvas.h - bbox.h（元素完整可見）」變成
    // 「中心最多貼齊下緣＝上緣 1 - h/2H（露出下半）」。仍然擋掉「整個掉出畫面」。
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 0, dy: 5000 }, { w: 400, h: 100 }, CANVAS);
    expect(r.position.y).toBeLessThanOrEqual(1 - 100 / (2 * 1920));
    expect(r.position.y).toBeCloseTo(1 - 100 / (2 * 1920), 6);
    expect(r.position.y).toBeLessThan(1); // 上緣沒有頂到畫布最底端＝沒有整個掉出去
  });

  it('純水平拖曳不得挪動 y：clamp 不能動使用者這次沒碰的那條軸', () => {
    // overlay 在 {x:0.4, y:0.9}、bbox 300×400（例如字級大的圖卡）：y 的正常 clamp 上限是
    // 1-400/1920 = 0.79167，起始值 0.9 本來就在上限外（AI 用 update_overlay 設偏下、或圖
    // 變高都拿得到這種值，不是髒資料）。使用者只往右拖 50px（dy=0），舊寫法會順手把 y 夾到
    // 0.79167——元素在畫面上自己往上跳 208px，而且會跟著這次拖曳被送出、永久存進 doc。
    const r = dragOverlay({ x: 0.4, y: 0.9 }, { dx: 50, dy: 0 }, { w: 300, h: 400 }, CANVAS);
    expect(r.position.y).toBeCloseTo(0.9, 6); // 沒碰的軸＝原封不動
    expect(r.position.x).toBeGreaterThan(0.4); // 有碰的軸＝照常移動
  });

  it('起點在界外時，clamp 只能把元素往畫布內拉，不能推得比起點更外面', () => {
    // 同上的起點，這次帶一點點垂直位移（dy=2px，人手拖曳幾乎不可能剛好是 0）——
    // 「只特判 dy===0」的修法在這裡就破功了，y 一樣會彈回 0.79167。
    const down = dragOverlay({ x: 0.4, y: 0.9 }, { dx: 50, dy: 2 }, { w: 300, h: 400 }, CANVAS);
    expect(down.position.y).toBeCloseTo(0.9, 6); // 往界外拖：擋在起點，不會愈拖愈糟
    // 往界內拖不受限：能一路拖回合法區間，clamp 不會把他鎖在 0.9
    const up = dragOverlay({ x: 0.4, y: 0.9 }, { dx: 0, dy: -400 }, { w: 300, h: 400 }, CANVAS);
    expect(up.position.y).toBeCloseTo(0.9 - 400 / 1920, 6);
  });

  it('底部安全邊距吸附時，新的 y clamp 不會蓋掉吸附結果（snap 贏過 clamp）', () => {
    // bbox h=100：底部安全邊距候選 y = canvas.h*(1-0.05) - h = 1824-100 = 1724，
    // 落在吸附半徑內。新 clamp 上限 = canvas.h - h = 1820（換算 0-1 是 1820/1920），
    // 比 1724/1920 寬鬆——clamp 不會削掉這個已經吸附好的結果。
    const r = dragOverlay({ x: 0.5, y: 0.5 }, { dx: 50, dy: 760 }, { w: 400, h: 100 }, CANVAS);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 1824 });
    expect(r.position.y).toBeCloseTo(1724 / 1920, 6);
  });
});

describe('dragCaption', () => {
  it('y 位移換算 + 夾限', () => {
    expect(dragCaption(0.72, 192, 92, 1920).y).toBeCloseTo(0.82);
    // 2026-08-04 起：中心留在畫布內，上下各可露出半張卡（舊規則是必須完整可見）
    expect(dragCaption(0.9, 500, 92, 1920).y).toBeLessThanOrEqual(1 - 92 / (2 * 1920));
    expect(dragCaption(0.1, -500, 92, 1920).y).toBeGreaterThanOrEqual(-92 / (2 * 1920));
  });

  it('高字卡且起點在界外：1px 的手勢不得把字幕彈上去（clamp 規則與 dragOverlay 一致）', () => {
    // cardH=400（字級大或多行的字卡）→ 正常上限只有 1-400/1920 = 0.79167，
    // 而 y=0.9 是 set_captions 正常設得出來的值。硬 clamp 的話，使用者只碰了 1px，
    // 字幕就往上跳 208px（0.9 → 0.79167），並且跟著這次拖曳被送出、永久存進 doc。
    expect(dragCaption(0.9, 1, 400, 1920).y).toBeCloseTo(0.9, 6);
    // 往界內拖不受限：一路拖得回合法區間，不會被鎖在 0.9
    expect(dragCaption(0.9, -400, 400, 1920).y).toBeCloseTo(0.9 - 400 / 1920, 6);
    // 起點本來就合法時：硬拖出下緣夾在「中心貼齊下緣」＝ 1 - cardH/2H
    expect(dragCaption(0.5, 5000, 400, 1920).y).toBeCloseTo(1 - 400 / (2 * 1920), 6);
  });
});

// 2026-08-04：使用者回報「字幕/overlay 左右可以超出畫布，上下不行」。成因不是「上下忘了做」，
// 是兩條軸各自夾錨點的值——x 錨中心、y 錨上緣，同樣的寫法產生不同的視覺語意。
// 新規則：中心留在畫布內，四邊各可露出一半。
describe('四邊都可以超出畫布（中心留在畫布內）', () => {
  const CANVAS = { w: 1080, h: 1920 };
  const BOX = { w: 400, h: 300 };

  it('可以往上拖到掛在畫布上緣外（y 變負值）', () => {
    // 起點上緣 y=0.1（=192px），往上拖 150px → 上緣 42px…再往上就是舊版夾死的地方
    const r = dragOverlay({ x: 0.5, y: 0.1 }, { dx: 0, dy: -260 }, BOX, CANVAS);
    expect(r.position.y).toBeLessThan(0); // 舊版這裡恆為 0
    // 中心仍在畫布內：中心 = y*H + h/2 >= 0
    expect(r.position.y * CANVAS.h + BOX.h / 2).toBeGreaterThanOrEqual(-0.01);
  });

  it('可以往下拖到掛在畫布下緣外（超過舊上限 1-h/H）', () => {
    const oldLimit = 1 - BOX.h / CANVAS.h; // 0.84375
    const r = dragOverlay({ x: 0.5, y: 0.8 }, { dx: 0, dy: 400 }, BOX, CANVAS);
    expect(r.position.y).toBeGreaterThan(oldLimit);
  });

  it('中心不得離開畫布：硬往上拖到底也只停在「中心貼齊上緣」', () => {
    const r = dragOverlay({ x: 0.5, y: 0.5 }, { dx: 0, dy: -99999 }, BOX, CANVAS);
    expect(r.position.y).toBeCloseTo(-BOX.h / (2 * CANVAS.h), 4); // 中心 = 0
  });

  it('中心不得離開畫布：硬往下拖到底也只停在「中心貼齊下緣」', () => {
    const r = dragOverlay({ x: 0.5, y: 0.5 }, { dx: 0, dy: 99999 }, BOX, CANVAS);
    expect(r.position.y).toBeCloseTo(1 - BOX.h / (2 * CANVAS.h), 4); // 中心 = H
  });

  it('水平行為不變：中心仍夾在 [0,1]，最多露出一半', () => {
    const l = dragOverlay({ x: 0.5, y: 0.3 }, { dx: -99999, dy: 0 }, BOX, CANVAS);
    const rr = dragOverlay({ x: 0.5, y: 0.3 }, { dx: 99999, dy: 0 }, BOX, CANVAS);
    expect(l.position.x).toBeCloseTo(0, 4);
    expect(rr.position.x).toBeCloseTo(1, 4);
  });

  it('純水平拖曳仍然不得挪動 y（clampAxis 的區間含起點性質沒被放寬弄丟）', () => {
    const start = { x: 0.4, y: 0.95 }; // 舊上限 0.84375 之外
    const r = dragOverlay(start, { dx: 50, dy: 0 }, BOX, CANVAS);
    expect(r.position.y).toBeCloseTo(start.y, 4);
  });

  it('字幕同一條規則：可以拖到掛在畫布下緣外', () => {
    const cardH = 300;
    const oldLimit = 1 - cardH / 1920;
    const r = dragCaption(0.8, 400, cardH, 1920);
    expect(r.y).toBeGreaterThan(oldLimit);
    expect(r.y).toBeLessThanOrEqual(1 - cardH / (2 * 1920) + 1e-9);
  });
});
