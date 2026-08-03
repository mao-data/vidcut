import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ProjectStore } from './store.js';
import type { FontEntry } from './fonts.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';

/**
 * HTTP 面：/api/project（debug）、/api/fonts+/fonts/:id（字型表，供 UI @font-face）、
 * /media/*（原生 Range，給 <video>）、POST /assets（UI 上傳疊圖等素材）、/（UI build，存在時）。
 */
export function createApp(
  store: ProjectStore,
  projectDir: string,
  uiDistDir?: string,
  extras?: { fonts?: FontEntry[]; textCards?: TextCardService },
): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/api/project', (_req, res) => {
    res.json({ version: store.version, doc: store.doc });
  });

  // 上傳素材（binary body）。檔名只取 basename（防 path traversal）、重名自動編號。
  app.post(
    '/assets',
    express.raw({ type: () => true, limit: '20mb' }), // 不看 Content-Type，一律當 binary
    (req, res, next) => {
      void (async () => {
        const raw = typeof req.query.name === 'string' ? req.query.name : '';
        const clean = basename(raw).replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
        if (!clean || !Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: 'need ?name= and binary body' });
          return;
        }
        await mkdir(join(projectDir, 'assets'), { recursive: true });
        const ext = extname(clean);
        const stem = clean.slice(0, clean.length - ext.length);
        let rel = join('assets', clean);
        for (let i = 1; existsSync(join(projectDir, rel)); i++) {
          rel = join('assets', `${stem}-${i}${ext}`);
        }
        await writeFile(join(projectDir, rel), req.body);
        res.json({ relPath: rel });
      })().catch(next);
    },
  );

  app.get('/api/fonts', (_req, res) => {
    res.json((extras?.fonts ?? []).map((f) => ({ id: f.id, family: f.family })));
  });
  app.get('/fonts/:id', (req, res) => {
    const f = extras?.fonts?.find((x) => x.id === req.params.id);
    if (!f) {
      res.status(404).end();
      return;
    }
    res.sendFile(f.path);
  });

  // 內容定址字卡：URL 變 = 內容變，故可強快取＋immutable。POST 產卡端點必須先於 static 掛，
  // 否則 static 的 fallthrough:false 會把 POST /text-card/preview 攔成 404。
  app.post('/text-card/preview', (req, res, next) => {
    void (async () => {
      const svc = extras?.textCards;
      if (!svc) {
        res.status(503).json({ error: 'text cards unavailable' });
        return;
      }
      const b = req.body as Partial<CardRequest>;
      if (!b || typeof b.text !== 'string' || !b.style) {
        res.status(400).json({ error: 'need text + style' });
        return;
      }
      res.json(await svc.ensure({ ...b, width: b.width ?? store.doc.canvas.width } as CardRequest));
    })().catch(next);
  });
  app.use(
    '/text-card',
    express.static(join(projectDir, 'derived', 'text'), {
      fallthrough: false,
      immutable: true,
      maxAge: '365d', // 內容定址：URL 變 = 內容變
    }),
  );

  app.use('/media', express.static(projectDir, { fallthrough: false }));
  if (uiDistDir && existsSync(uiDistDir)) app.use(express.static(uiDistDir));
  return app;
}
