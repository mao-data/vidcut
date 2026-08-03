import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { cardKey, TextCardService } from '../src/textCards.js';
import { PillowRasterizer, type CardRequest } from '../src/rasterizer.js';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

const REQ: CardRequest = {
  text: '哈囉世界',
  tokens: ['哈囉', '世界'],
  style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff', stroke: '#000000', highlight: '#FCDE5A' },
  width: 1080,
};

describe('cardKey', () => {
  it('same input → same key; 與時間無關的欄位不影響 key', () => {
    expect(cardKey(REQ, 'pillow-1')).toBe(cardKey({ ...REQ }, 'pillow-1'));
  });
  it('改字必變;換 rasterizerId 必變', () => {
    expect(cardKey({ ...REQ, text: '改了' }, 'pillow-1')).not.toBe(cardKey(REQ, 'pillow-1'));
    expect(cardKey(REQ, 'chromium-1')).not.toBe(cardKey(REQ, 'pillow-1'));
  });
});

describe('TextCardService', () => {
  it('ensure 產卡落盤;第二次命中快取(檔案 mtime 不變)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    expect(a.tokens).toHaveLength(2);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    const m1 = (await stat(baseAbs)).mtimeMs;
    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash);
    expect((await stat(baseAbs)).mtimeMs).toBe(m1); // 沒重畫
  }, 30_000);
});

// HTTP 面：驅動真的 Express app（真的 listen + fetch），不是直接呼叫 service。
// 保護的是路由層屬性（掛載順序、驗證），單元測試碰不到。
async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-http-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const svc = new TextCardService(dir, raster);
  const server: Server = createServer(createApp(store, dir, undefined, { textCards: svc }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, store, server, base: `http://127.0.0.1:${port}` };
}

describe('HTTP: /text-card/*', () => {
  it('POST /text-card/preview 合法 body → 200 + 16-hex hash + geometry；且是唯讀（store.version 不變）', async () => {
    const { store, server, base } = await startTestServer();
    const versionBefore = store.version;
    // 這條 assertion 通過本身就證明了掛載順序正確：POST 真的到了 handler，
    // 而不是被 `/text-card` static（fallthrough:false）攔成 404。
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { hash: string; width: number; height: number; lines: number };
    expect(j.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(j.width).toBeGreaterThan(0);
    expect(j.height).toBeGreaterThan(0);
    expect(j.lines).toBeGreaterThan(0);
    expect(store.version).toBe(versionBefore); // POST 唯讀，不寫 doc

    // 卡已經落盤，static 端點可讀到非空檔案。
    const png = await fetch(`${base}/text-card/${j.hash}.base.png`);
    expect(png.status).toBe(200);
    const buf = Buffer.from(await png.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(0);

    server.close();
  }, 30_000);

  it('POST /text-card/preview 缺必填 style 子欄位 → 400（不是被 ensure 丟出的 500）', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', style: {} }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(typeof j.error).toBe('string');
    server.close();
  });
});
