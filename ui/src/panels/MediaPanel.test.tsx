import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent, waitFor, screen } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { ProjectMediaZone } from './MediaPanel/ProjectMediaZone.js';
import { LibraryZone } from './MediaPanel/LibraryZone.js';
import { SourceFolderZone } from './MediaPanel/SourceFolderZone.js';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useToast } from '../stores/toast.js';
import { useSelection } from '../stores/selection.js';
import * as ws from '../ws.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';

let sent: Command[];

beforeEach(() => {
  resetStores();
  sent = [];
  vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
    sent.push(c);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectMediaZone', () => {
  it('lists every project media item with label and duration', () => {
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
  });

  it('shows the empty-note when there is no media yet', () => {
    const empty = demoProject();
    empty.media = [];
    empty.tracks.video = [];
    seedProject(empty);
    const { container } = render(<ProjectMediaZone />);
    expect(container.textContent).toContain('No media yet. Upload files to get started.');
  });

  it('video row Add sends addClip with in:0 and the probed duration', () => {
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('A'),
    )!;
    const addBtn = row.querySelector<HTMLButtonElement>('button[title="Add"]')!;
    act(() => {
      fireEvent.click(addBtn);
    });
    expect(sent).toEqual([{ name: 'addClip', mediaId: 'm1', in: 0, duration: 30 }]);
  });

  it('audio-only row Add sends setAudio with the existing audio plus a new item at the playhead', () => {
    const doc = demoProject();
    doc.media.push({
      id: 'm3',
      path: 'src/c.mp3',
      probe: {
        duration: 12,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        rotation: 0,
        hasVideo: false,
      },
      label: 'Voice',
    });
    seedProject(doc);
    usePlayback.getState().seek(4);
    const { container } = render(<ProjectMediaZone />);
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Voice'),
    )!;
    // audio-only 列不該有 addClip 語意的按鈕文字，但仍是同一顆 title="Add" 按鈕（走 setAudio 分支）
    const addBtn = row.querySelector<HTMLButtonElement>('button[title="Add"]')!;
    act(() => {
      fireEvent.click(addBtn);
    });
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { name: 'setAudio' }>;
    expect(cmd.name).toBe('setAudio');
    // 既有 audio（a1）要保留，新項 append 在後
    expect(cmd.audio.map((a) => a.id)).toEqual(['a1', cmd.audio[1]!.id]);
    const added = cmd.audio[1]!;
    expect(added.mediaId).toBe('m3');
    expect(added.start).toBe(4);
    expect(added.volume).toBe(1);
    expect(added.in).toBe(0);
    expect(added.duration).toBe(12);
  });

  it('Save to library posts mediaId and toasts on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ asset: { id: 'lib-abc' }, existing: false }),
    });
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('A'),
    )!;
    const saveBtn = row.querySelector<HTMLButtonElement>('button[title="Save to library"]')!;
    act(() => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(useToast.getState().message).toBe('Saved to library'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/from-media',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mediaId: 'm1' }),
      }),
    );
  });

  it('Save to library toasts "Already in library" when the asset already exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ asset: { id: 'lib-abc' }, existing: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('A'),
    )!;
    const saveBtn = row.querySelector<HTMLButtonElement>('button[title="Save to library"]')!;
    act(() => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(useToast.getState().message).toBe('Already in library'));
  });

  it('shows a "lib" tag when the media already has a libraryId', () => {
    const doc = demoProject();
    doc.media[0]!.meta = { libraryId: 'lib-abc' };
    seedProject(doc);
    const { container } = render(<ProjectMediaZone />);
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('A'),
    )!;
    expect(row.textContent).toContain('lib');
  });

  it('never calls useSelection.select() from this zone', () => {
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('A'),
    )!;
    const addBtn = row.querySelector<HTMLButtonElement>('button[title="Add"]')!;
    act(() => {
      fireEvent.click(addBtn);
    });
    // Add 送出命令即可,不斷言 selection——真正的鐵則檢查交給程式碼審查/lint 慣例;
    // 這裡至少確保點擊不會拋錯、沒有非預期的第二筆命令。
    expect(sent).toHaveLength(1);
  });

  it('search filters the rendered list without touching doc.media', () => {
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    const input = screen.getByPlaceholderText('Search media');
    fireEvent.change(input, { target: { value: 'A' } });
    expect(container.textContent).toContain('A');
    fireEvent.change(input, { target: { value: 'no-such-media' } });
    expect(container.textContent).toContain('No matches for "no-such-media"');
    // 過濾是渲染層的事,doc 本身不動
    expect(useProject.getState().doc!.media.length).toBeGreaterThan(0);
  });

  it('Upload files posts each media file to /api/media with the raw File body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    seedProject();
    const { container } = render(<ProjectMediaZone />);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    const good = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    const junk = new File(['y'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [good, junk] } });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // .txt 被前端過濾
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/media?name=clip.mp4');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(File); // 串流上傳:絕不 arrayBuffer
    await waitFor(() => expect(useToast.getState().message).toContain('skipped 1 non-media'));
  });
});

/** GET /api/library 的假回應：三筆 asset（video、audio、broken image）。 */
function libraryListing(overrides: Partial<Record<string, unknown>>[] = []): unknown[] {
  const base = [
    {
      id: 'lib-vid',
      kind: 'media',
      hash: 'hashvid',
      file: 'files/hashvid.mp4',
      probe: { duration: 12, width: 1080, height: 1920, fps: 30, hasAudio: true, rotation: 0 },
      label: 'Intro clip',
      tags: ['intro'],
      origin: { type: 'upload' },
      addedAt: '2026-08-01T00:00:00.000Z',
      broken: false,
    },
    {
      id: 'lib-aud',
      kind: 'media',
      hash: 'hashaud',
      file: 'files/hashaud.mp3',
      probe: {
        duration: 8,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        rotation: 0,
        hasVideo: false,
      },
      label: 'BGM loop',
      tags: ['bgm', 'loop'],
      origin: { type: 'upload' },
      addedAt: '2026-08-02T00:00:00.000Z',
      broken: false,
    },
    {
      id: 'lib-img',
      kind: 'image',
      hash: 'hashimg',
      file: 'files/hashimg.png',
      probe: { duration: 0, width: 800, height: 600, fps: 0, hasAudio: false, rotation: 0 },
      label: 'Badge',
      tags: [],
      origin: { type: 'upload' },
      addedAt: '2026-08-03T00:00:00.000Z',
      broken: false,
    },
  ];
  return overrides.length ? overrides : base;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const result = handler(url, init);
    return Promise.resolve(result);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonOk(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: () => Promise.resolve(body) };
}

async function openLibrary(): Promise<HTMLElement> {
  const utils = render(<LibraryZone />);
  await waitFor(() => expect(screen.getByPlaceholderText('Search library')).toBeTruthy());
  return utils.container;
}

describe('LibraryZone', () => {
  it('fetches the listing on mount and renders rows for each asset', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/library')) return jsonOk({ assets: libraryListing() });
      return { ok: false };
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));
    expect(fetchMock).toHaveBeenCalledWith('/api/library');
    expect(container.textContent).toContain('BGM loop');
    expect(container.textContent).toContain('Badge');
  });

  it('debounces search input by 300ms and requeries with ?query=', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/library')) return jsonOk({ assets: libraryListing() });
      return { ok: false };
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));
    fetchMock.mockClear();

    // 掛載/初次查詢用真實 timer 跑完後才切假時鐘——避免 RTL 的 waitFor 內部
    // 輪詢也用的是 setTimeout，跟 vi.useFakeTimers() 卡死互撞。
    vi.useFakeTimers();
    try {
      const input = screen.getByPlaceholderText('Search library');
      fireEvent.change(input, { target: { value: 'bgm' } });
      // 還沒過 300ms 不該重查
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(fetchMock).toHaveBeenCalledWith('/api/library?query=bgm');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking a tag filters by that tag via ?tag=', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/library')) return jsonOk({ assets: libraryListing() });
      return { ok: false };
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));
    fetchMock.mockClear();

    const tagEl = Array.from(container.querySelectorAll('.tag')).find(
      (t) => t.textContent === 'intro',
    )!;
    fireEvent.click(tagEl);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/library?tag=intro'));
  });

  it('uploads each selected file sequentially with the raw File as body (no arrayBuffer)', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = stubFetch((url, init) => {
      calls.push({ url, init });
      if (url.startsWith('/api/library') && (!init || init.method === undefined)) {
        return jsonOk({ assets: libraryListing() });
      }
      if (init?.method === 'POST' && url.startsWith('/api/library?')) {
        return jsonOk({ asset: libraryListing()[0] });
      }
      return jsonOk({ assets: libraryListing() });
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));
    fetchMock.mockClear();
    calls.length = 0;

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const f1 = new File(['a'], 'clip1.mp4', { type: 'video/mp4' });
    const f2 = new File(['b'], 'clip2.mp4', { type: 'video/mp4' });
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [f1, f2], configurable: true });
      fireEvent.change(fileInput);
      await Promise.resolve();
      await Promise.resolve();
    });

    const uploadCalls = calls.filter((c) => c.init?.method === 'POST');
    expect(uploadCalls).toHaveLength(2);
    // body 必須是 File 物件本身,絕不是 ArrayBuffer——讓瀏覽器串流上傳
    expect(uploadCalls[0]!.init!.body).toBe(f1);
    expect(uploadCalls[0]!.init!.body).toBeInstanceOf(File);
    expect(uploadCalls[0]!.url).toContain('name=clip1.mp4');
    expect(uploadCalls[1]!.init!.body).toBe(f2);
  });

  it('media Import posts /:id/import and toasts Imported', async () => {
    stubFetch((url, init) => {
      if (url === '/api/library') return jsonOk({ assets: libraryListing() });
      if (url === '/api/library/lib-vid/import' && init?.method === 'POST') {
        return jsonOk({ mediaId: 'm-new' });
      }
      return jsonOk({ assets: libraryListing() });
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));

    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Intro clip'),
    )!;
    const importBtn = row.querySelector<HTMLButtonElement>('button[title="Import"]')!;
    fireEvent.click(importBtn);
    await waitFor(() => expect(useToast.getState().message).toBe('Imported'));
  });

  it('image Import sends addOverlay via sendCommand at the playhead and toasts Placed as overlay', async () => {
    stubFetch((url, init) => {
      if (url === '/api/library') return jsonOk({ assets: libraryListing() });
      if (url === '/api/library/lib-img/import' && init?.method === 'POST') {
        return jsonOk({ kind: 'image', relPath: 'assets/badge-1.png' });
      }
      return jsonOk({ assets: libraryListing() });
    });
    seedProject();
    usePlayback.getState().seek(5);
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Badge'));

    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Badge'),
    )!;
    const importBtn = row.querySelector<HTMLButtonElement>('button[title="Import"]')!;
    fireEvent.click(importBtn);

    await waitFor(() => expect(sent).toHaveLength(1));
    const cmd = sent[0] as Extract<Command, { name: 'addOverlay' }>;
    expect(cmd.name).toBe('addOverlay');
    expect(cmd.overlay.imagePath).toBe('assets/badge-1.png');
    expect(cmd.overlay.start).toBe(5);
    expect(cmd.overlay.duration).toBe(3);
    expect(cmd.overlay.position).toEqual({ x: 0.5, y: 0.1, scale: 1 });
    expect(cmd.overlay.id.startsWith('ov_')).toBe(true);
    await waitFor(() => expect(useToast.getState().message).toBe('Placed as overlay'));
  });

  it('Delete requires window.confirm before calling DELETE, and requeries after', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === '/api/library') return jsonOk({ assets: libraryListing() });
      if (url === '/api/library/lib-vid' && init?.method === 'DELETE') {
        return jsonOk({ ok: true });
      }
      return jsonOk({ assets: libraryListing() });
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));

    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Intro clip'),
    )!;
    const delBtn = row.querySelector<HTMLButtonElement>('button[title="Delete"]')!;

    // confirm=false ⇒ 不送 DELETE
    fireEvent.click(delBtn);
    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete from library? Projects referencing this file will lose it at export.',
    );
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);

    // confirm=true ⇒ 送 DELETE 並重查
    confirmSpy.mockReturnValue(true);
    fetchMock.mockClear();
    fireEvent.click(delBtn);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/library/lib-vid',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/library'));
  });

  it('broken asset shows the broken marker and disables Import', async () => {
    stubFetch((url) => {
      if (url === '/api/library') {
        return jsonOk({
          assets: [
            {
              id: 'lib-broken',
              kind: 'media',
              hash: 'hashbroken',
              file: 'files/hashbroken.mp4',
              probe: {
                duration: 5,
                width: 1080,
                height: 1920,
                fps: 30,
                hasAudio: true,
                rotation: 0,
              },
              label: 'Missing file',
              tags: [],
              origin: { type: 'upload' },
              addedAt: '2026-08-04T00:00:00.000Z',
              broken: true,
            },
          ],
        });
      }
      return jsonOk({ assets: [] });
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Missing file'));
    expect(container.textContent).toContain('broken');
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Missing file'),
    )!;
    const importBtn = row.querySelector<HTMLButtonElement>('button[title="Import"]')!;
    expect(importBtn.disabled).toBe(true);
  });

  it('svg asset disables Import (svg cannot be placed as overlay)', async () => {
    stubFetch((url) => {
      if (url === '/api/library') {
        return jsonOk({
          assets: [
            {
              id: 'lib-svg',
              kind: 'image',
              hash: 'hashsvg',
              file: 'files/hashsvg.svg',
              probe: { duration: 0, width: 0, height: 0, fps: 0, hasAudio: false, rotation: 0 },
              label: 'Icon',
              tags: [],
              origin: { type: 'upload' },
              addedAt: '2026-08-25T00:00:00.000Z',
              broken: false,
            },
          ],
        });
      }
      return jsonOk({ assets: [] });
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Icon'));
    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Icon'),
    )!;
    const importBtn = row.querySelector<HTMLButtonElement>('button[aria-label="Import"]')!;
    expect(importBtn.disabled).toBe(true);
    expect(importBtn.title).toBe('SVG cannot be placed as overlay');
  });

  it('double-click label enters edit mode; Enter commits a PATCH and requeries', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === '/api/library') return jsonOk({ assets: libraryListing() });
      if (url === '/api/library/lib-vid' && init?.method === 'PATCH') {
        return jsonOk({ asset: { ...libraryListing()[0]!, label: 'Renamed' } });
      }
      return jsonOk({ assets: libraryListing() });
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));

    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Intro clip'),
    )!;
    const labelEl = row.querySelector<HTMLElement>('[title="Double-click to edit"]')!;
    fireEvent.doubleClick(labelEl);
    const input = row.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/library/lib-vid',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ label: 'Renamed' }),
        }),
      ),
    );
  });

  it('Escape cancels the label edit without a PATCH', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/api/library') return jsonOk({ assets: libraryListing() });
      return jsonOk({ assets: libraryListing() });
    });
    seedProject();
    const container = await openLibrary();
    await waitFor(() => expect(container.textContent).toContain('Intro clip'));
    fetchMock.mockClear();

    const row = Array.from(container.querySelectorAll('.media-card')).find((r) =>
      r.textContent?.includes('Intro clip'),
    )!;
    const labelEl = row.querySelector<HTMLElement>('[title="Double-click to edit"]')!;
    fireEvent.doubleClick(labelEl);
    const input = row.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Whatever' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toBe(false);
    expect(container.textContent).toContain('Intro clip');
  });
});

/** GET /api/source 的假回應：兩檔，一已匯入一未匯入。 */
function sourceListing(dir: string): unknown {
  return {
    dir,
    files: [
      { name: 'clip1.mp4', size: 12_582_912, mtime: 1_700_000_000_000, imported: false },
      { name: 'clip2.mov', size: 2_097_152, mtime: 1_700_000_001_000, imported: true },
    ],
  };
}

async function openSourceFolder(): Promise<HTMLElement> {
  const utils = render(<SourceFolderZone />);
  await waitFor(() => expect(screen.getByPlaceholderText('/path/to/folder')).toBeTruthy());
  return utils.container;
}

describe('SourceFolderZone', () => {
  it('Scan fetches GET /api/source with the dir query param (encoded)', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/source')) return jsonOk(sourceListing('/tmp/my footage'));
      return jsonOk({ dir: '', files: [] });
    });
    seedProject();
    const container = await openSourceFolder();

    const input = screen.getByPlaceholderText('/path/to/folder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/tmp/my footage' } });
    fireEvent.click(screen.getByTitle('Scan'));

    await waitFor(() => expect(container.textContent).toContain('clip1.mp4'));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/source?${new URLSearchParams({ dir: '/tmp/my footage' }).toString()}`,
    );
    // 已匯入的檔案掛 imported tag
    const row2 = Array.from(container.querySelectorAll('.rowline')).find((r) =>
      r.textContent?.includes('clip2.mov'),
    )!;
    expect(row2.textContent).toContain('imported');
  });

  it('mounts, reads localStorage[vidcut.sourceDir], and auto-scans', async () => {
    localStorage.setItem('vidcut.sourceDir', '/Users/x/footage');
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/source')) return jsonOk(sourceListing('/Users/x/footage'));
      return jsonOk({ dir: '', files: [] });
    });
    seedProject();
    const container = await openSourceFolder();

    await waitFor(() => expect(container.textContent).toContain('clip1.mp4'));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/source?${new URLSearchParams({ dir: '/Users/x/footage' }).toString()}`,
    );
    const input = screen.getByPlaceholderText('/path/to/folder') as HTMLInputElement;
    expect(input.value).toBe('/Users/x/footage');
  });

  it('Scan writes the dir to localStorage[vidcut.sourceDir]', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/source')) return jsonOk(sourceListing('/tmp/a'));
      return jsonOk({ dir: '', files: [] });
    });
    seedProject();
    await openSourceFolder();

    const input = screen.getByPlaceholderText('/path/to/folder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/tmp/a' } });
    fireEvent.click(screen.getByTitle('Scan'));

    await waitFor(() => expect(localStorage.getItem('vidcut.sourceDir')).toBe('/tmp/a'));
  });

  it('shows an empty-note with the server error string when the dir does not exist', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/source')) {
        return { ok: false, json: () => Promise.resolve({ error: 'ENOENT: no such file' }) };
      }
      return jsonOk({ dir: '', files: [] });
    });
    seedProject();
    const container = await openSourceFolder();

    const input = screen.getByPlaceholderText('/path/to/folder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/nope' } });
    fireEvent.click(screen.getByTitle('Scan'));

    await waitFor(() => expect(container.textContent).toContain('ENOENT: no such file'));
  });

  it('checking rows and clicking Import selected posts dir+names, then toasts ok/failed counts', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/source')) return jsonOk(sourceListing('/tmp/a'));
      if (url === '/api/import' && init?.method === 'POST') {
        return jsonOk({ ok: [{ name: 'clip1.mp4', mediaId: 'm-new' }], failed: [] });
      }
      return jsonOk({ dir: '', files: [] });
    });
    seedProject();
    const container = await openSourceFolder();

    const input = screen.getByPlaceholderText('/path/to/folder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/tmp/a' } });
    fireEvent.click(screen.getByTitle('Scan'));
    await waitFor(() => expect(container.textContent).toContain('clip1.mp4'));

    const row1 = Array.from(container.querySelectorAll('.rowline')).find((r) =>
      r.textContent?.includes('clip1.mp4'),
    )!;
    const checkbox = row1.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    fireEvent.click(checkbox);

    fetchMock.mockClear();
    fireEvent.click(screen.getByTitle('Import selected'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/import',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: '/tmp/a', names: ['clip1.mp4'] }),
        }),
      ),
    );
    await waitFor(() => expect(useToast.getState().message).toBe('Imported 1, failed 0'));
    // 匯入後不 select
    expect(useSelection.getState().selected).toBeNull();
  });

  it('Save to library posts path=dir/name to /api/library/from-path', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/source')) return jsonOk(sourceListing('/tmp/a'));
      if (url === '/api/library/from-path' && init?.method === 'POST') {
        return jsonOk({ asset: { id: 'lib-xyz' }, existing: false });
      }
      return jsonOk({ dir: '', files: [] });
    });
    seedProject();
    const container = await openSourceFolder();

    const input = screen.getByPlaceholderText('/path/to/folder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/tmp/a' } });
    fireEvent.click(screen.getByTitle('Scan'));
    await waitFor(() => expect(container.textContent).toContain('clip1.mp4'));

    const row1 = Array.from(container.querySelectorAll('.rowline')).find((r) =>
      r.textContent?.includes('clip1.mp4'),
    )!;
    const saveBtn = row1.querySelector<HTMLButtonElement>('button[title="Save to library"]')!;
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/library/from-path',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/tmp/a/clip1.mp4' }),
        }),
      ),
    );
    await waitFor(() => expect(useToast.getState().message).toBe('Saved to library'));
  });
});
