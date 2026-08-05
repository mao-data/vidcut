// startServer 的啟動韌性：字卡光柵器（python3 + Pillow）是附屬功能，
// 不能因為它壞掉就讓整個 server 起不來——loadFontTable 跑在 listen() 之前。
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/index.js';

describe('startServer 的啟動韌性', () => {
  it('PATH 上沒有 python3 時仍然 listen 並服務 API（字卡功能降級成空字型表）', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-for-vidcut-test';
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-boot-'));
    let close: (() => void) | null = null;
    try {
      const { server } = await startServer(dir, 0);
      close = () => server.close();
      const port = (server.address() as AddressInfo).port;
      // server 真的在服務：UI 打得開、專案讀得到。
      expect((await fetch(`http://127.0.0.1:${port}/api/project`)).status).toBe(200);
      // 字型表是空的（一個候選都 probe 不了），不是拋例外把啟動整條打斷。
      expect(await (await fetch(`http://127.0.0.1:${port}/api/fonts`)).json()).toEqual([]);
    } finally {
      process.env.PATH = prevPath;
      close?.();
    }
  }, 30_000);
});
