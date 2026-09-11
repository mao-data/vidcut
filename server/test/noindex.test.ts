import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { tmpDir } from './tmp.js';

async function startTestServer() {
  const dir = await tmpDir('vidcut-noindex-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const server: Server = createServer(createApp(store, dir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

/**
 * 每個回應都要帶 `X-Robots-Tag: noindex`。
 *
 * 這個 server 在自架時綁 127.0.0.1,爬蟲根本到不了,header 無害;但同一份程式
 * 部署在雲端(studio.usevidcut.com 與每人一台的 <slug>.studio 子網域)時是公開
 * 可達的——2026-09-10 實測兩個 host 都 200、無任何索引控制,編輯器殼頁的
 * <title>vidcut</title> 會進 Google 索引,跟行銷站搶品牌詞,之後每個使用者
 * 子網域還會各自變成一頁可索引的垃圾頁。
 *
 * 用 header 而不是 robots.txt:robots.txt 的 Disallow 只擋「抓取」不擋「收錄」
 * (外部連結仍可讓網址以無內容形式進索引),而 noindex 要被看到才生效,兩者
 * 同時上反而互相抵銷。header 對所有路由(含 404 與 /media)一體適用。
 */
describe('X-Robots-Tag', () => {
  it('marks API responses noindex', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/api/project`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    server.close();
  });

  it('marks unknown routes noindex too (blanket, not per-route)', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/no-such-page`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    server.close();
  });
});
