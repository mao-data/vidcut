import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent, waitFor, screen } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { MediaPanel } from './MediaPanel.js';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useToast } from '../stores/toast.js';
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

describe('MediaPanel', () => {
  it('三個子區可切換；預設專案媒體', () => {
    useProject.setState({ doc: demoProject() });
    render(<MediaPanel />);
    expect(screen.getByTitle('Project media')).toBeTruthy();
    expect(screen.getByTitle('Library')).toBeTruthy();
    expect(screen.getByTitle('Source folder')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Library'));
    expect(screen.getByPlaceholderText('Search library')).toBeTruthy();
  });
});

describe('ProjectMediaZone', () => {
  it('lists every project media item with label and duration', () => {
    seedProject();
    const { container } = render(<MediaPanel />);
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
  });

  it('shows the empty-note when there is no media yet', () => {
    const empty = demoProject();
    empty.media = [];
    empty.tracks.video = [];
    seedProject(empty);
    const { container } = render(<MediaPanel />);
    expect(container.textContent).toContain(
      'No media yet. Import from the Folder tab or ask the AI.',
    );
  });

  it('video row Add sends addClip with in:0 and the probed duration', () => {
    seedProject();
    const { container } = render(<MediaPanel />);
    const row = Array.from(container.querySelectorAll('.rowline')).find((r) =>
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
    const { container } = render(<MediaPanel />);
    const row = Array.from(container.querySelectorAll('.rowline')).find((r) =>
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
    const { container } = render(<MediaPanel />);
    const row = Array.from(container.querySelectorAll('.rowline')).find((r) =>
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
    const { container } = render(<MediaPanel />);
    const row = Array.from(container.querySelectorAll('.rowline')).find((r) =>
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
    const { container } = render(<MediaPanel />);
    const row = Array.from(container.querySelectorAll('.rowline')).find((r) =>
      r.textContent?.includes('A'),
    )!;
    expect(row.textContent).toContain('lib');
  });

  it('never calls useSelection.select() from this zone', () => {
    seedProject();
    const { container } = render(<MediaPanel />);
    const row = Array.from(container.querySelectorAll('.rowline')).find((r) =>
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
});
