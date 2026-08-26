// 打字三段式(本地近似 → 80ms debounce 預覽卡 → commit 才送命令)的行為測試。
// CaptionLayer.test.tsx 只驗證「拿到 draft prop 之後怎麼畫」；這裡驗證「draft prop 是怎麼來的」——
// schedulePreview/cancelPreview 的 debounce、過期回應的競態防護、以及四條清空路徑
// (commit / Escape / unmount / 換選取)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { CaptionList } from './CaptionList.js';
import { useEditDraft } from '../stores/editDraft.js';
import { useSelection } from '../stores/selection.js';
import * as ws from '../ws.js';
import { seedProject, resetStores } from '../test/fixtures.js';

let sent: Command[];

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as Response;
}

/** 雙擊 rowText 那一列進入編輯模式,回傳該列的 <input>。 */
function startEdit(container: HTMLElement, rowText: string): HTMLInputElement {
  const row = Array.from(container.querySelectorAll('div')).find((d) => d.textContent === rowText);
  if (!row) throw new Error(`row not found: ${rowText}`);
  act(() => {
    fireEvent.doubleClick(row);
  });
  const input = container.querySelector('input');
  if (!input) throw new Error('edit input did not appear');
  return input;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

/** 推進 debounce 計時器,並讓 fetch().then() 鏈的微任務有機會跑完。 */
async function advancePastDebounce(ms = 80) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  resetStores();
  useEditDraft.getState().clear();
  sent = [];
  vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
    sent.push(c);
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useEditDraft.getState().clear();
});

describe('CaptionList — typing pipeline', () => {
  it('typing sends no command (stage 1 is local-only, never reaches sendCommand)', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ hash: 'h' }))),
    );
    seedProject();
    const { container } = render(<CaptionList />);
    const input = startEdit(container, 'first line');

    typeInto(input, 'f');
    typeInto(input, 'fi');
    typeInto(input, 'fir');

    expect(sent).toEqual([]);
    expect(sent.some((c) => c.name === 'updateCaption')).toBe(false);
  });

  it('debounce coalescing: three keystrokes in quick succession fire exactly one fetch, with the FINAL text', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ hash: 'h' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container } = render(<CaptionList />);
    const input = startEdit(container, 'first line');

    typeInto(input, 'f');
    typeInto(input, 'fi');
    typeInto(input, 'fir');

    await advancePastDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/text-card/preview');
    const body = JSON.parse(init!.body as string) as { text: string; width?: number };
    expect(body.text).toBe('fir'); // 最終文字,不是中間那兩次('f'/'fi')
    // Task 5：**不得帶 `width`**。以前硬編 1080 蓋掉 server 的 `doc.canvas.width` 預設,
    // 直式畫布下剛好同值所以看不出來;畫布換寬之後,打字預覽卡與 commit 後的正式卡會是
    // 不同 hash——使用者打字時看到的排版跟按 Enter 之後的排版不一樣,兩端都不會報錯。
    expect('width' in body).toBe(false);
  });

  it('race guard: a stale in-flight response for superseded text must not overwrite a fresher one', async () => {
    // 手動控制兩次 fetch 各自的 resolve 時機,模擬「請求 A('ab')還沒回來、
    // 使用者已經又打了字變成'abc'、請求 B('abc')送出去了」這個真實會發生的順序。
    const resolvers: Array<{ text: string; resolve: (v: Response) => void }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? '{}') as { text: string };
        return new Promise<Response>((resolve) => {
          resolvers.push({ text: body.text, resolve });
        });
      }),
    );
    seedProject();
    const { container } = render(<CaptionList />);
    const input = startEdit(container, 'first line');

    typeInto(input, 'ab');
    await advancePastDebounce(); // 請求 A('ab')送出,尚未 resolve
    expect(resolvers).toHaveLength(1);
    expect(resolvers[0]!.text).toBe('ab');

    typeInto(input, 'abc'); // 使用者接著打字;store 的 text 現在是 'abc'
    await advancePastDebounce(); // 請求 B('abc')送出,尚未 resolve
    expect(resolvers).toHaveLength(2);
    expect(resolvers[1]!.text).toBe('abc');

    // 請求 A 這時候才回來(飛行時間比 B 久)——過期,不該套用
    await act(async () => {
      resolvers[0]!.resolve(jsonResponse({ hash: 'staleHash' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useEditDraft.getState().caption).toEqual({ id: 'cap1', text: 'abc', previewHash: null });

    // 請求 B 回來,text 跟目前 draft 吻合——該套用
    await act(async () => {
      resolvers[1]!.resolve(jsonResponse({ hash: 'freshHash' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useEditDraft.getState().caption).toEqual({
      id: 'cap1',
      text: 'abc',
      previewHash: 'freshHash',
    });
  });

  it('cancel on commit: pending debounce is cancelled by Enter, no preview fetch fires afterwards', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ hash: 'h' })));
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container } = render(<CaptionList />);
    const input = startEdit(container, 'first line');

    typeInto(input, 'rewritten'); // 排了一顆 80ms 後才會發的 debounce
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' }); // 還沒到 80ms 就 commit
    });

    await advancePastDebounce(200); // 就算時間過了,已取消的 timer 不該再發

    expect(fetchMock).not.toHaveBeenCalled();
    const updateCaptionCmds = sent.filter((c) => c.name === 'updateCaption');
    expect(updateCaptionCmds).toHaveLength(1);
    expect(updateCaptionCmds[0]).toEqual({
      name: 'updateCaption',
      id: 'cap1',
      patch: { text: 'rewritten', tokens: [] },
    });
  });

  it('cancel on unmount: no fetch fires after the component is gone', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ hash: 'h' })));
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container, unmount } = render(<CaptionList />);
    const input = startEdit(container, 'first line');

    typeInto(input, 'rewritten'); // debounce 排進去,還沒發

    unmount();
    await advancePastDebounce(200);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('draft cleared on Escape', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ hash: 'h' }))),
    );
    seedProject();
    const { container } = render(<CaptionList />);
    const input = startEdit(container, 'first line');

    typeInto(input, 'nope');
    expect(useEditDraft.getState().caption).not.toBeNull();

    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(useEditDraft.getState().caption).toBeNull();
    expect(sent).toEqual([]);
  });

  it('draft cleared on selection change (the safety-net effect, not just blur)', async () => {
    // 這條路徑在滑鼠操作下通常是 no-op(mousedown 會先讓 input blur,blur 已經清過了)——
    // 這裡直接改 useSelection,繞過 blur,專門測那個保險絲 effect 本身。
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ hash: 'h' })));
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container } = render(<CaptionList />);
    const input = startEdit(container, 'first line');
    typeInto(input, 'still editing'); // 排了 debounce,且 useEditDraft 已經有內容

    expect(useEditDraft.getState().caption).not.toBeNull();

    act(() => {
      useSelection.getState().select({ kind: 'caption', id: 'cap2' }); // 換到別句,不經過 blur
    });

    expect(useEditDraft.getState().caption).toBeNull();
    // 本地 draft 也要清:輸入框要消失,列表退回純文字顯示
    expect(container.querySelector('input')).toBeNull();

    await advancePastDebounce(200); // 被取消的 debounce 不該補發
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent).toEqual([]); // 換選取是丟棄,不是 commit
  });
});
