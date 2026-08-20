import { describe, it, expect, beforeEach } from 'vitest';
import { useView } from './view.js';
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND, zoomBoundsFor } from '../timeline/scale.js';

/**
 * 涵蓋兩個冪等展開：
 *   `openLeft`  AgentStrip 點擊要「指向活動流而且看得到它」（活動流 2026-08-16
 *               版面重構後住在左邊的 AI 專區）
 *   `openRight` 選了東西要「跳到 Properties 分頁而且看得到它」
 * 兩者都不能用 `toggle*`——本來就開著的話會被關掉，正好相反的效果。
 * 其餘 view state（縮放/吸附/寬度）由 `panelResize.test.ts` 與元件測試涵蓋。
 */

beforeEach(() => {
  // 這個檔案不走 test/fixtures.ts 的 resetStores()（不需要 seedProject 那一整套），
  // 但這裡的 `fit()` describe 區塊會真的把 zoomBounds 改成非預設值（例如
  // min≈0.69）——module 級 store 沒有測試框架自動歸零，不重置就會洩漏給後面
  // 的 `userZoomed` 區塊：`zoomBy`/`setPxPerSecond` 都吃 get().zoomBounds 做
  // clampPps，殘留的窄 bounds 會讓那邊的斷言在不知情的 clamp 規則下通過或失敗
  // （review round 1 抓到，見 test/fixtures.ts 的 resetStores 同款修正）。
  useView.setState({
    leftOpen: true,
    rightOpen: true,
    zoomBounds: { min: MIN_PX_PER_SECOND, max: MAX_PX_PER_SECOND },
  });
});

describe('useView.openRight（冪等展開）', () => {
  it('收合時展開', () => {
    useView.setState({ rightOpen: false });
    useView.getState().openRight();
    expect(useView.getState().rightOpen).toBe(true);
  });

  it('已經開著時維持開著——不是 toggle', () => {
    useView.getState().openRight();
    expect(useView.getState().rightOpen).toBe(true);
    useView.getState().openRight();
    expect(useView.getState().rightOpen).toBe(true);
  });

  it('不動左欄', () => {
    useView.setState({ leftOpen: false, rightOpen: false });
    useView.getState().openRight();
    expect(useView.getState().leftOpen).toBe(false);
  });

  it('已經開著時不通知訂閱者（避免無謂重繪）', () => {
    let notified = 0;
    const un = useView.subscribe(() => {
      notified += 1;
    });
    useView.getState().openRight();
    useView.getState().openRight();
    expect(notified).toBe(0);
    un();
  });
});

describe('useView.openLeft（冪等展開）', () => {
  it('收合時展開', () => {
    useView.setState({ leftOpen: false });
    useView.getState().openLeft();
    expect(useView.getState().leftOpen).toBe(true);
  });

  it('已經開著時維持開著——不是 toggle', () => {
    useView.getState().openLeft();
    expect(useView.getState().leftOpen).toBe(true);
    useView.getState().openLeft();
    expect(useView.getState().leftOpen).toBe(true);
  });

  it('不動右欄', () => {
    useView.setState({ leftOpen: false, rightOpen: false });
    useView.getState().openLeft();
    expect(useView.getState().rightOpen).toBe(false);
  });

  it('已經開著時不通知訂閱者（避免無謂重繪）', () => {
    let notified = 0;
    const un = useView.subscribe(() => {
      notified += 1;
    });
    useView.getState().openLeft();
    useView.getState().openLeft();
    expect(notified).toBe(0);
    un();
  });
});

/**
 * Review round 1 抓到的迴歸：`fit()` 曾經只更新 `zoomBounds` 卻用
 * `fitPps()`（內部走靜態 DEFAULT_BOUNDS，下限 5）算 `pxPerSecond`，
 * 長專案「整片剛好入鏡」的目標被吃掉——算出 min≈0.69 卻落地在 5。
 * `fit()` 現在必須用它剛算好的**同一份動態 bounds**去夾同一個 raw fit 值。
 */
describe('useView.fit（長專案要真正整片入鏡，不被靜態下限攔住）', () => {
  it('長專案(1687s @ 1200px)：fit 後 pxPerSecond 落在 zoomBoundsFor().min（遠低於舊 MIN=5）', () => {
    const { min } = zoomBoundsFor(1687, 1200);
    expect(min).toBeLessThan(5); // 前提：這個案例本來就該低於舊靜態下限
    useView.getState().fit(1687, 1200);
    expect(useView.getState().pxPerSecond).toBeCloseTo(min, 5);
    expect(useView.getState().zoomBounds.min).toBeCloseTo(min, 5);
    // 整個專案真的塞進視窗（扣掉左右留白）
    const totalPx = 1687 * useView.getState().pxPerSecond;
    expect(totalPx).toBeLessThanOrEqual(1200);
  });

  it('短專案(10s @ 640px)：fit 後下限仍是 5，pxPerSecond 用整片入鏡值(60)', () => {
    useView.getState().fit(10, 640);
    expect(useView.getState().zoomBounds.min).toBe(5);
    expect(useView.getState().pxPerSecond).toBe(60); // (640-40)/10
  });
});

/**
 * `userZoomed` 旗標（Plan 9 Task 2）：Timeline 層的自動 fit 政策要靠它判斷
 * 「使用者自上次 fit 後有沒有手動縮放過」。這裡只測旗標本身的讀寫語意，
 * 「誰在什麼時機讀它去決定要不要 fit」是 Timeline.autofit.test.tsx 的範圍。
 */
describe('useView.userZoomed（手動縮放旗標）', () => {
  beforeEach(() => {
    useView.setState({ userZoomed: false, pxPerSecond: 40 });
  });

  it('初始為 false', () => {
    expect(useView.getState().userZoomed).toBe(false);
  });

  it('zoomBy 設為 true', () => {
    useView.getState().zoomBy(1.2);
    expect(useView.getState().userZoomed).toBe(true);
  });

  it('setPxPerSecond 設為 true', () => {
    useView.getState().setPxPerSecond(80);
    expect(useView.getState().userZoomed).toBe(true);
  });

  it('fit() 清回 false（即使呼叫前是 true）', () => {
    useView.setState({ userZoomed: true });
    useView.getState().fit(10, 640);
    expect(useView.getState().userZoomed).toBe(false);
  });
});
