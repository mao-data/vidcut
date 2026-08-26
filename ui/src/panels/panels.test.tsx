import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command, ReviewOutcome } from '@vidcut/shared';
import { Inspector } from './Inspector.js';
import { CaptionList } from './CaptionList.js';
import { ExportMenu } from './ExportMenu.js';
import { ReviewBar } from './ReviewBar.js';
import { useSelection } from '../stores/selection.js';
import { usePlayback } from '../stores/playback.js';
import { useAgent, NO_CALLS } from '../stores/agent.js';
import * as ws from '../ws.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';

let sent: Command[];

/** 依 label 文字找到它下面那個表單控件（.form 是 label→input 依序排列）。 */
function fieldAfter(c: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(c.querySelectorAll('label')).find((l) =>
    l.textContent?.includes(labelText),
  );
  if (!label) throw new Error(`label not found: ${labelText}`);
  const inside = label.querySelector('input');
  if (inside) return inside as HTMLInputElement;
  const next = label.nextElementSibling;
  if (!(next instanceof HTMLInputElement)) throw new Error(`no input after label: ${labelText}`);
  return next;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

function clickTitle(c: HTMLElement, title: string) {
  const el = c.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!el) throw new Error(`button not found by title: ${title}`);
  act(() => {
    fireEvent.click(el);
  });
}

function clickText(c: HTMLElement, text: string) {
  const el = Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`button not found: ${text}`);
  act(() => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  resetStores();
  // agent 是模組級 store，`resetStores()` 不管它（它是階段 2 才加的，fixtures 沒收）。
  // 不清的話一個測試留下的進行中呼叫會讓下一個測試的索引卡卡在 working 態。
  useAgent.setState({ calls: NO_CALLS });
  sent = [];
  vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
    sent.push(c);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Inspector', () => {
  it('prompts for a selection when nothing is selected', () => {
    seedProject();
    const { container } = render(<Inspector />);
    expect(container.textContent).toContain('Select a clip');
  });

  // AI 區塊（三態索引卡＋最近活動署名列＋session 讀數）**已搬離本面板**——
  // 使用者 2026-08-16 版面定案：它連同活動流住進左邊的全高 AI 專區。
  // 整組行為契約跟著搬到 `AgentPanel.test.tsx`（斷言逐條保留）。
  // 這裡留一條反向哨兵：Inspector 不得再長回第二份索引卡（兩個地方顯示同一個
  // agent 狀態時，它們遲早會在同一時刻說不同的話——C3b 擋的就是那件事）。
  it('the agent block lives in the AI column, not here', () => {
    seedProject();
    const { container } = render(<Inspector />);
    expect(container.textContent).not.toContain('AI agent');
    expect(container.querySelector('.ap-card')).toBeNull();
  });

  it('edits a clip: label, in, duration, volume', () => {
    seedProject();
    useSelection.getState().select({ kind: 'clip', id: 'c1' });
    const { container } = render(<Inspector />);

    type(fieldAfter(container, 'Source in'), '3');
    type(fieldAfter(container, 'Duration'), '5');
    type(fieldAfter(container, 'Volume'), '0.5');
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c1', patch: { in: 3 } },
      { name: 'updateClip', clipId: 'c1', patch: { duration: 5 } },
      { name: 'updateClip', clipId: 'c1', patch: { volume: 0.5 } },
    ]);
  });

  it('clip actions split, freeze, extract audio, and delete', () => {
    seedProject();
    usePlayback.getState().seek(2);
    useSelection.getState().select({ kind: 'clip', id: 'c1' });
    const { container } = render(<Inspector />);

    clickText(container, 'Split');
    clickText(container, 'Freeze');
    clickText(container, 'Extract audio');
    expect(sent).toEqual([
      { name: 'splitAt', time: 2 },
      { name: 'freezeFrame', time: 2 },
      { name: 'extractAudio', clipId: 'c1' },
    ]);
  });

  it('edits an audio item including the ducking toggle', () => {
    seedProject();
    useSelection.getState().select({ kind: 'audio', id: 'a1' });
    const { container } = render(<Inspector />);

    type(fieldAfter(container, 'Fade in'), '1.5');
    const duck = fieldAfter(container, 'Duck the video track');
    act(() => {
      fireEvent.click(duck);
    });
    expect(sent).toEqual([
      { name: 'updateAudio', id: 'a1', patch: { fadeIn: 1.5 } },
      { name: 'updateAudio', id: 'a1', patch: { ducking: true } },
    ]);
  });

  it('edits a caption: text, start, duration', () => {
    seedProject();
    useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    const { container } = render(<Inspector />);

    type(fieldAfter(container, 'Start (s)'), '2');
    expect(sent).toEqual([{ name: 'updateCaption', id: 'cap1', patch: { start: 2 } }]);
  });

  // 以前這個欄位是 `value` + `onChange`：**每一鍵一筆 updateCaption**——每個按鍵都是一筆
  // history、一次字卡重產（實測 33 個字 → derived/text/ 多 99 個檔，而那個目錄沒有 GC）。
  // 現在跟同一面板的文字 overlay Text 欄一致：打字純本地，失焦才送一筆。
  it('caption Text: 打字期間一個命令都不送,失焦才送一筆(不再每鍵灌爆 history)', () => {
    seedProject();
    useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    const { container } = render(<Inspector />);
    const ta = container.querySelector('textarea')!;
    expect(ta.value).toBe('first line');

    for (const v of ['f', 'fi', 'fix', 'fixed line']) {
      fireEvent.change(ta, { target: { value: v } });
    }
    expect(sent).toEqual([]);

    fireEvent.blur(ta);
    expect(sent).toEqual([
      { name: 'updateCaption', id: 'cap1', patch: { text: 'fixed line', tokens: [] } },
    ]);
  });

  // 2026-08-05：這個欄位以前只送 { text }。對**有逐詞時間戳的句子**（cap2）那是一次
  // 靜默 no-op——字卡是照 tokens 排版的（text_card.py 的 render_cards 在有 tokens 時走
  // layout_tokens，cfg["text"] 從頭到尾沒被讀過），所以文件裡的 text 換了、產出的 PNG
  // 卻與改字前逐位元組相同：畫面沒變化、沒有錯誤訊息，使用者只會以為自己打錯地方。
  // CaptionList.tsx 的打字路徑一直有清 tokens，只有這個入口漏了。
  it('caption Text: 有 karaoke tokens 的句子改字必須一併清掉 tokens（否則是靜默 no-op）', () => {
    seedProject();
    useSelection.getState().select({ kind: 'caption', id: 'cap2' });
    const { container } = render(<Inspector />);
    const ta = container.querySelector('textarea')!;
    expect(ta.value).toBe('second line');

    fireEvent.change(ta, { target: { value: '換成別的字' } });
    fireEvent.blur(ta);
    expect(sent).toEqual([
      { name: 'updateCaption', id: 'cap2', patch: { text: '換成別的字', tokens: [] } },
    ]);
  });

  it('caption Text: 沒改就失焦不送命令(silent-overwrite guard)', () => {
    seedProject();
    useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    const { container } = render(<Inspector />);
    fireEvent.blur(container.querySelector('textarea')!);
    expect(sent).toEqual([]);
  });

  // 非受控輸入的老問題：id 沒變、值從外部變了（AI 的 update_caption、或字幕列表那條
  // 三段式改完 commit 回來的 echo）。沒有把值編進 key 的話 React 沿用同一個 DOM 節點、
  // defaultValue 不會重套，面板停在舊字；使用者接著一 blur 就把外部的修改靜默蓋掉。
  it('caption Text: 外部改了同一句（id 不變）→ 欄位要跟著更新', () => {
    const doc = demoProject();
    seedProject(doc);
    useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    const { container, rerender } = render(<Inspector />);
    const before = container.querySelector('textarea')!;
    expect(before.value).toBe('first line');

    const patched = structuredClone(doc);
    patched.tracks.captions[0]!.text = '外部改過的字';
    act(() => {
      seedProject(patched, 2);
    });
    rerender(<Inspector />);

    const after = container.querySelector('textarea')!;
    expect(after.value).toBe('外部改過的字');
    expect(after).not.toBe(before); // key 變 → remount，不是靠 React 去改非受控節點
  });

  it('an absolute overlay shows a start field and sends start', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);

    type(fieldAfter(container, 'Start (s)'), '4');
    expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAbs', patch: { start: 4 } }]);
  });

  it('an anchored overlay shows an offset field and sends an anchor', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAnchor' });
    const { container } = render(<Inspector />);

    type(fieldAfter(container, 'Offset from clip'), '2');
    expect(sent).toEqual([
      { name: 'updateOverlay', id: 'ovAnchor', patch: { anchor: { clipId: 'c2', offset: 2 } } },
    ]);
  });

  it('the anchor offset field accepts negative values (overlay may lead its clip)', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAnchor' });
    const { container } = render(<Inspector />);

    const input = fieldAfter(container, 'Offset from clip');
    expect(input.min).toBe(''); // min="0" 會讓瀏覽器步進/驗證擋掉負值，與拖曳語意衝突
    type(input, '-1.5');
    expect(sent).toEqual([
      { name: 'updateOverlay', id: 'ovAnchor', patch: { anchor: { clipId: 'c2', offset: -1.5 } } },
    ]);
  });

  it('"until end" switches duration between null and a fixed length', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);

    const box = fieldAfter(container, 'until end');
    act(() => {
      fireEvent.click(box);
    });
    expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAbs', patch: { duration: null } }]);
  });

  it('deleting an overlay also clears the selection', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);

    clickText(container, 'Delete overlay');
    expect(sent).toEqual([{ name: 'removeOverlay', id: 'ovAbs' }]);
    expect(useSelection.getState().selected).toBeNull();
  });

  it('switches the canvas fill mode', () => {
    seedProject();
    const { container } = render(<Inspector />);
    clickText(container, 'Blur fill');
    expect(sent).toEqual([{ name: 'setCanvasFit', fit: 'blur' }]);
  });

  it('text overlay: Inspector 顯示文字欄位,改字送 updateOverlay(text 完整物件)', () => {
    const doc = demoProject();
    doc.tracks.overlays = [
      {
        id: 'txt1',
        imagePath: 'derived/text/abc.base.png',
        text: { text: '原字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    ];
    seedProject(doc);
    useSelection.getState().select({ kind: 'overlay', id: 'txt1' });
    const { container } = render(<Inspector />);
    const ta = container.querySelector('textarea')!;
    expect(ta.value).toBe('原字');
    fireEvent.change(ta, { target: { value: '新字' } });
    fireEvent.blur(ta);
    expect(sent).toEqual([
      {
        name: 'updateOverlay',
        id: 'txt1',
        patch: { text: { text: '新字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' } },
      },
    ]);
  });

  it('switching selected text overlay refreshes Font size / Fill instead of showing stale values', () => {
    const doc = demoProject();
    doc.tracks.overlays = [
      {
        id: 'txtA',
        imagePath: 'derived/text/a.base.png',
        text: { text: 'A字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
      {
        id: 'txtB',
        imagePath: 'derived/text/b.base.png',
        text: { text: 'B字', fontFamily: 'Heiti TC', fontSize: 32, fill: '#ff0000' },
        start: 2,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    ];
    seedProject(doc);
    useSelection.getState().select({ kind: 'overlay', id: 'txtA' });
    const { container, rerender } = render(<Inspector />);
    expect(fieldAfter(container, 'Font size').value).toBe('64');
    expect(fieldAfter(container, 'Color').value).toBe('#ffffff');

    useSelection.getState().select({ kind: 'overlay', id: 'txtB' });
    rerender(<Inspector />);
    expect(fieldAfter(container, 'Font size').value).toBe('32');
    expect(fieldAfter(container, 'Color').value).toBe('#ff0000');
  });

  // 上面那條「換選取」其實用 `key={ov.id}` 也會通過（換 overlay 時 id 跟值一起變）。
  // 這條才是那個修法真正要擋的情形：**id 沒變、值從外部變了**——AI 用 update_overlay
  // 改了字級/顏色，或別的 session 的編輯 echo 回來。React 沿用同一個 DOM 節點，
  // 非受控 input 的 defaultValue 不會重新套用，面板會一直顯示舊值；使用者接著在
  // 那個欄位 blur，就會拿舊值把 AI 剛寫進去的值蓋掉（silent overwrite）。
  it('AI 從外部改了同一個 overlay 的字級/顏色（id 不變）→ 面板要跟著更新', () => {
    const doc = demoProject();
    doc.tracks.overlays = [
      {
        id: 'txtA',
        imagePath: 'derived/text/a.base.png',
        text: { text: 'A字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    ];
    seedProject(doc);
    useSelection.getState().select({ kind: 'overlay', id: 'txtA' });
    const { container, rerender } = render(<Inspector />);
    expect(fieldAfter(container, 'Font size').value).toBe('64');
    expect(fieldAfter(container, 'Color').value).toBe('#ffffff');
    const before = fieldAfter(container, 'Font size');

    // server echo：同一個 overlay id，只有值變了（走真正的 applyServerMsg 路徑）
    const patched = structuredClone(doc);
    patched.tracks.overlays[0]!.text = {
      text: 'A字',
      fontFamily: 'Heiti TC',
      fontSize: 96,
      fill: '#00ff00',
    };
    act(() => {
      seedProject(patched, 2);
    });
    rerender(<Inspector />);

    expect(fieldAfter(container, 'Font size').value).toBe('96');
    expect(fieldAfter(container, 'Color').value).toBe('#00ff00');
    // 而且是**換了一個 DOM 節點**（key 變 → remount），不是靠 React 去改非受控 input
    expect(fieldAfter(container, 'Font size')).not.toBe(before);
  });

  it('blurring Font size without changing it sends nothing (silent-overwrite guard)', () => {
    const doc = demoProject();
    doc.tracks.overlays = [
      {
        id: 'txt1',
        imagePath: 'derived/text/abc.base.png',
        text: { text: '原字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    ];
    seedProject(doc);
    useSelection.getState().select({ kind: 'overlay', id: 'txt1' });
    const { container } = render(<Inspector />);
    fireEvent.blur(fieldAfter(container, 'Font size'));
    expect(sent).toEqual([]);
  });
});

/**
 * 版面與命名的回歸檢查。這些不是「功能會不會壞」，是「使用者會不會讀錯意思」：
 * 勾選框排在它控制的欄位之前、同一個概念在四個表單有三個名字、刪除鈕跟一般操作
 * 擠在同一排——每一條都在使用者回報「放的地方不直觀」的名單上（2026-08-05）。
 */
describe('Inspector — 版面與命名', () => {
  const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('label'));
  const labelWith = (c: HTMLElement, text: string) =>
    labels(c).find((l) => l.textContent?.includes(text));
  const buttonWith = (c: HTMLElement, text: string) =>
    Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

  it('「until end」開著時 Duration 欄位留在原地變灰，不是整組消失', () => {
    // 消失的話版面會往上跳，勾選框頓時失去它所修飾的對象，看起來像在講上一個欄位。
    const doc = demoProject();
    doc.tracks.overlays[0]!.duration = null;
    seedProject(doc);
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);

    const dur = fieldAfter(container, 'Duration');
    expect(dur.disabled).toBe(true);
    expect(dur.value).toBe('to end of video');
  });

  it('「until end」勾選框跟 Duration 同一組，且排在 Duration 標籤之後', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);

    const durLabel = labelWith(container, 'Duration')!;
    const check = labels(container).find((l) => l.querySelector('input[type="checkbox"]'))!;
    expect(check).toBeTruthy();
    expect(check.parentElement).toBe(durLabel.parentElement);
    expect(durLabel.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('錨定 overlay 的偏移欄位有自己的名字，錨在哪一段另外講', () => {
    // 舊版把說明和 clip 名稱全塞進 label：「Anchored to clip (offset in s; follows
    // the clip):clip two」，200px 下擠成兩行，而下面那個數字是什麼得自己猜。
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAnchor' });
    const { container } = render(<Inspector />);

    expect(fieldAfter(container, 'Offset from clip').value).toBe('0.5');
    expect(container.textContent).toContain('clip two');
  });

  it('時間軸起點在 audio / caption / overlay 三個表單都叫 Start (s)', () => {
    seedProject();
    const selections = [
      { kind: 'audio', id: 'a1' },
      { kind: 'caption', id: 'cap1' },
      { kind: 'overlay', id: 'ovAbs' },
    ] as const;
    for (const sel of selections) {
      useSelection.getState().select(sel);
      const { container, unmount } = render(<Inspector />);
      expect(labelWith(container, 'Start (s)'), `${sel.kind} 少了 Start (s)`).toBeTruthy();
      unmount();
    }
  });

  it('顏色欄位在字幕與文字 overlay 都叫 Color', () => {
    const doc = demoProject();
    doc.tracks.overlays = [
      {
        id: 'txt1',
        imagePath: 'derived/text/abc.base.png',
        text: { text: '字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    ];
    seedProject(doc);

    useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    const cap = render(<Inspector />);
    expect(fieldAfter(cap.container, 'Color').type).toBe('color');
    cap.unmount();

    useSelection.getState().select({ kind: 'overlay', id: 'txt1' });
    const ov = render(<Inspector />);
    expect(fieldAfter(ov.container, 'Color').type).toBe('color');
  });

  it('overlay 表單不混用全形括號', () => {
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);
    expect(container.textContent).not.toMatch(/[（）]/);
  });

  /** 這個 label 落在哪一個小節標題底下（沒有分段就回 null）。 */
  const sectionOf = (c: HTMLElement, labelText: string) => {
    const el = labels(c).find((l) => l.textContent?.trim().startsWith(labelText));
    if (!el) throw new Error(`label not found: ${labelText}`);
    let current: string | null = null;
    for (const h of Array.from(c.querySelectorAll('.section'))) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        current = h.textContent;
      }
    }
    return current;
  };

  it('overlay 表單分成 Timing / Position / Style 三段', () => {
    const doc = demoProject();
    doc.tracks.overlays = [
      {
        id: 'txt1',
        imagePath: 'derived/text/abc.base.png',
        text: { text: '字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    ];
    seedProject(doc);
    useSelection.getState().select({ kind: 'overlay', id: 'txt1' });
    const { container } = render(<Inspector />);

    expect(Array.from(container.querySelectorAll('.section')).map((h) => h.textContent)).toEqual([
      'Timing',
      'Position',
      'Style',
    ]);
    expect(sectionOf(container, 'Start (s)')).toBe('Timing');
    expect(sectionOf(container, 'Duration')).toBe('Timing');
    expect(sectionOf(container, 'x')).toBe('Position');
    expect(sectionOf(container, 'Scale')).toBe('Position');
    expect(sectionOf(container, 'Font size')).toBe('Style');
  });

  it('audio 表單把時間與音量分開', () => {
    seedProject();
    useSelection.getState().select({ kind: 'audio', id: 'a1' });
    const { container } = render(<Inspector />);

    expect(sectionOf(container, 'Start (s)')).toBe('Timing');
    expect(sectionOf(container, 'Source in')).toBe('Timing');
    expect(sectionOf(container, 'Volume')).toBe('Levels');
    expect(sectionOf(container, 'Fade in')).toBe('Levels');
    expect(sectionOf(container, 'Duck the video track')).toBe('Levels');
  });

  it('caption 表單把時間與樣式分開，Text 留在最上面不歸段', () => {
    seedProject();
    useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    const { container } = render(<Inspector />);

    expect(sectionOf(container, 'Text')).toBe(null);
    expect(sectionOf(container, 'Start (s)')).toBe('Timing');
    expect(sectionOf(container, 'Font size')).toBe('Style');
    expect(sectionOf(container, 'Color')).toBe('Style');
  });

  it('clip 表單不分段——四個欄位加小標只是雜訊', () => {
    seedProject();
    useSelection.getState().select({ kind: 'clip', id: 'c1' });
    const { container } = render(<Inspector />);
    expect(container.querySelectorAll('.section')).toHaveLength(0);
  });

  it('x 與 y 併成一列，Scale 獨立一行', () => {
    // 三欄放不下：200px 面板下每格只剩 37px 文字空間，而畫布拖曳寫進來的是四位小數
    // （demo 專案現有 -0.0688，要 42px），三欄會把它截成 -0.0——使用者讀到錯的數字。
    seedProject();
    useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    const { container } = render(<Inspector />);

    const x = fieldAfter(container, 'x (0–1)');
    const y = fieldAfter(container, 'y (0–1)');
    const scale = fieldAfter(container, 'Scale');
    const duo = container.querySelector('.duo');

    expect(duo).toBeTruthy();
    expect(duo!.contains(x)).toBe(true);
    expect(duo!.contains(y)).toBe(true);
    expect(duo!.contains(scale)).toBe(false);
  });

  it('Delete clip 不跟 Split / Freeze 擠在同一排', () => {
    // 同一個 flexWrap 裡換行後，刪除鈕會落在不可預期的位置，很容易誤點。
    seedProject();
    useSelection.getState().select({ kind: 'clip', id: 'c1' });
    const { container } = render(<Inspector />);

    const del = buttonWith(container, 'Delete clip')!;
    const split = container.querySelector('button[title="S"]')!;
    expect(del).toBeTruthy();
    expect(split).toBeTruthy();
    expect(del.parentElement).not.toBe(split.parentElement);
  });
});

describe('CaptionList', () => {
  it('lists every caption with its start time', () => {
    seedProject();
    const { container } = render(<CaptionList />);
    expect(container.textContent).toContain('first line');
    expect(container.textContent).toContain('second line');
    expect(container.textContent).toContain('0:01.0');
  });

  it('editing text clears the stale word timestamps', () => {
    // 詞邊界對新文字沒有意義；留著會讓高亮跟著錯的詞跑
    seedProject();
    const { container } = render(<CaptionList />);
    const row = Array.from(container.querySelectorAll('div')).find(
      (d) => d.textContent === 'second line',
    )!;
    act(() => {
      fireEvent.doubleClick(row);
    });
    // 搜尋框也是 input 且排在最前（.panel-bar 內）——編輯框在列內（.panel-body），
    // 必須限定 .panel-body 才抓得到，否則抓到搜尋框、編輯永遠不會送出。
    const input = container.querySelector('.panel-body input')!;
    act(() => {
      fireEvent.change(input, { target: { value: 'rewritten' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(sent).toEqual([
      { name: 'updateCaption', id: 'cap2', patch: { text: 'rewritten', tokens: [] } },
    ]);
  });

  it('escape abandons an edit without sending anything', () => {
    seedProject();
    const { container } = render(<CaptionList />);
    const row = Array.from(container.querySelectorAll('div')).find(
      (d) => d.textContent === 'first line',
    )!;
    act(() => {
      fireEvent.doubleClick(row);
    });
    const input = container.querySelector('.panel-body input')!;
    act(() => {
      fireEvent.change(input, { target: { value: 'nope' } });
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(sent).toEqual([]);
  });

  it('deleting a caption sends the remaining ones', () => {
    seedProject();
    const { container } = render(<CaptionList />);
    // 刪除鈕原本是 ✕ 文字、靠 textContent 定位；改成 lucide 圖示後沒有文字節點，
    // 改用它的 aria-label（圖示鈕唯一的可及名稱）。
    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete this caption"]',
    )!;
    act(() => {
      fireEvent.click(del);
    });
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { name: 'setCaptions' }>;
    expect(cmd.name).toBe('setCaptions');
    expect(cmd.captions.map((c) => c.id)).toEqual(['cap2']);
  });

  it('applies the first caption style to all of them', () => {
    seedProject();
    const { container } = render(<CaptionList />);
    clickText(container, 'Style to all');
    const cmd = sent[0] as Extract<Command, { name: 'setCaptions' }>;
    expect(cmd.captions.every((c) => c.style.highlight === undefined)).toBe(true);
  });

  it('disabling karaoke strips tokens from every caption', () => {
    seedProject();
    const { container } = render(<CaptionList />);
    clickText(container, 'Disable karaoke');
    const cmd = sent[0] as Extract<Command, { name: 'setCaptions' }>;
    expect(cmd.captions.some((c) => c.tokens)).toBe(false);
  });

  it('tells the user how to get captions when there are none', () => {
    const empty = demoProject();
    empty.tracks.captions = [];
    seedProject(empty);
    const { container } = render(<CaptionList />);
    expect(container.textContent).toContain('auto_caption');
  });
});

describe('ExportMenu', () => {
  beforeEach(() => {
    vi.spyOn(ws, 'sendRender').mockImplementation(() => {});
    vi.spyOn(ws, 'sendSetCover').mockImplementation(() => {});
  });

  it('renders with the selected preset options', () => {
    seedProject();
    const { container } = render(<ExportMenu />);
    // 主鈕在非渲染中時直接送出（下拉是齒輪鈕的事）
    clickText(container, 'Export');
    expect(ws.sendRender).toHaveBeenCalledWith(
      expect.objectContaining({ crf: expect.any(Number) }),
    );
  });

  it('sets the cover from the current playhead', () => {
    seedProject();
    usePlayback.getState().seek(2.5);
    const { container } = render(<ExportMenu />);
    clickTitle(container, 'Export settings');
    clickText(container, 'Set cover');
    expect(ws.sendSetCover).toHaveBeenCalledWith(2.5);
  });

  it('shows render progress while running', () => {
    const doc = demoProject();
    doc.render = { status: 'running', progress: 42 };
    seedProject(doc);
    const { container } = render(<ExportMenu />);
    expect(container.textContent).toContain('42');
  });

  it('surfaces a render error', () => {
    const doc = demoProject();
    doc.render = { status: 'error', error: 'ffmpeg exploded' };
    seedProject(doc);
    const { container } = render(<ExportMenu />);
    clickTitle(container, 'Export settings');
    expect(container.textContent).toContain('ffmpeg exploded');
  });
});

describe('ReviewBar', () => {
  const withReview = () => {
    const doc = demoProject();
    doc.review = {
      id: 'r1',
      summary: 'trimmed the intro',
      sinceVersion: 1,
      requestedAt: new Date(0).toISOString(),
    };
    seedProject(doc);
  };
  let resolves: Array<[string, ReviewOutcome, string | undefined]>;
  beforeEach(() => {
    resolves = [];
    vi.spyOn(ws, 'sendReviewResolve').mockImplementation((id, outcome, note) => {
      resolves.push([id, outcome, note]);
    });
  });

  it('stays hidden when there is nothing to review', () => {
    seedProject();
    const { container } = render(<ReviewBar />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the AI's summary", () => {
    withReview();
    const { container } = render(<ReviewBar />);
    expect(container.textContent).toContain('trimmed the intro');
  });

  it('approves without a note', () => {
    withReview();
    const { container } = render(<ReviewBar />);
    clickText(container, 'Approve');
    expect(resolves).toEqual([['r1', 'approved', undefined]]);
  });

  it('cannot reject without a note, and can once one is written', () => {
    withReview();
    const { container } = render(<ReviewBar />);
    const reject = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reject'),
    )! as HTMLButtonElement;
    expect(reject.disabled).toBe(true);

    type(container.querySelector('input')!, 'undo that');
    expect(reject.disabled).toBe(false);
    act(() => {
      fireEvent.click(reject);
    });
    expect(resolves).toEqual([['r1', 'rejected', 'undo that']]);
  });
});
