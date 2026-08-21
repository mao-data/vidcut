// 發佈包區塊：render done 之後顯示上傳頁連結；有 publish 時列出包內檔案與警告。
import { describe, it, expect, beforeEach } from 'vitest';
import { render as rtlRender, fireEvent, act } from '@testing-library/react';
import type { Project } from '@vidcut/shared';
import { ExportMenu } from './ExportMenu.js';
import { demoProject, resetStores, seedProject } from '../test/fixtures.js';

function seedWithRender(render: Project['render']) {
  const doc = demoProject();
  doc.render = render;
  seedProject(doc);
}

function openMenu(container: HTMLElement) {
  const chevron = container.querySelector('button[title="Export settings"]');
  if (!chevron) throw new Error('chevron not found');
  act(() => {
    fireEvent.click(chevron);
  });
}

beforeEach(() => {
  resetStores();
});

describe('ExportMenu — publish section', () => {
  it('shows upload links once render is done, even without a package', () => {
    seedWithRender({ status: 'done', lastOutput: 'output/r1.mp4' });
    const { container } = rtlRender(<ExportMenu />);
    openMenu(container);
    expect(
      container.querySelector('a[href="https://www.tiktok.com/tiktokstudio/upload"]'),
    ).not.toBeNull();
    expect(container.querySelector('a[href="https://studio.youtube.com/"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://www.facebook.com/"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Publish package');
  });

  it('lists package files and warnings when publish exists', () => {
    seedWithRender({
      status: 'done',
      lastOutput: 'output/r1.mp4',
      publish: {
        dir: 'output/publish/r1',
        stamp: 'r1',
        platforms: ['tiktok'],
        files: ['output/publish/r1/video.mp4', 'output/publish/r1/tiktok.txt'],
        warnings: ['tiktok: video is 700s, over the 600s guideline'],
        createdAt: '2026-08-21T00:00:00.000Z',
      },
    });
    const { container } = rtlRender(<ExportMenu />);
    openMenu(container);
    expect(container.querySelector('a[href="/media/output/publish/r1/video.mp4"]')).not.toBeNull();
    expect(container.textContent).toContain('over the 600s guideline');
  });

  it('hides upload links before any render', () => {
    seedWithRender({ status: 'idle' });
    const { container } = rtlRender(<ExportMenu />);
    openMenu(container);
    expect(container.querySelector('a[href="https://studio.youtube.com/"]')).toBeNull();
  });
});
