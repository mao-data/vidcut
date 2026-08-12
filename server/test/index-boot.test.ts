// startServer 的啟動韌性：字卡光柵器（python3 + Pillow）是附屬功能，
// 不能因為它壞掉就讓整個 server 起不來——loadFontTable 跑在 listen() 之前。
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/index.js';
import { tmpDir } from './tmp.js';

describe('startServer 的啟動韌性', () => {
  it('PATH 上沒有 python3 時仍然 listen 並服務 API（字卡功能降級成空字型表）', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-for-vidcut-test';
    const dir = await tmpDir('vidcut-boot-');
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

  /**
   * port 被占用是新手的第一個坑（工作區常態就是好幾個 session 各起一台）。
   * 從前 listen 的 Promise 只接 callback、不接 'error'，於是 EADDRINUSE 變成
   * 未處理的 error 事件——使用者看到的是十幾行 Node 堆疊，裡面沒有一個字提到
   * VIDCUT_PORT。訊息要能直接照做，否則等於沒有訊息。
   */
  it('port 被占用時以可操作的訊息 reject，而不是丟未處理的 EADDRINUSE', async () => {
    const occupied = await startServer(await tmpDir('vidcut-port-a-'), 0);
    const port = (occupied.server.address() as AddressInfo).port;
    try {
      const second = startServer(await tmpDir('vidcut-port-b-'), port);
      await expect(second).rejects.toThrow(new RegExp(`${port}`));
      await expect(second).rejects.toThrow(/VIDCUT_PORT/);
    } finally {
      occupied.server.close();
    }
  }, 30_000);
});
