import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ProjectStore } from './store.js';
import type { FontEntry } from './fonts.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';

/** POST /text-card/preview 的手寫 body 驗證（故意不用 zod）：回 null 代表通過，否則回錯誤訊息。 */
function validateCardRequest(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'need text + style';
  const r = b as Partial<CardRequest>;
  if (typeof r.text !== 'string') return 'text must be a string';
  if (!r.style || typeof r.style !== 'object') return 'style is required';
  const s = r.style as Partial<CardRequest['style']>;
  if (typeof s.fontFamily !== 'string' || s.fontFamily === '') return 'style.fontFamily must be a non-empty string';
  if (typeof s.fontSize !== 'number' || !Number.isFinite(s.fontSize) || s.fontSize <= 0)
    return 'style.fontSize must be a finite number > 0';
  if (typeof s.fill !== 'string' || s.fill === '') return 'style.fill must be a non-empty string';
  if (s.stroke !== undefined && typeof s.stroke !== 'string') return 'style.stroke must be a string';
  if (s.highlight !== undefined && typeof s.highlight !== 'string') return 'style.highlight must be a string';
  if (r.tokens !== undefined && (!Array.isArray(r.tokens) || !r.tokens.every((t) => typeof t === 'string')))
    return 'tokens must be an array of strings';
  if (r.width !== undefined && (typeof r.width !== 'number' || !Number.isFinite(r.width)))
    return 'width must be a finite number';
  if (r.maxWidthFrac !== undefined) {
    if (typeof r.maxWidthFrac !== 'number' || !Number.isFinite(r.maxWidthFrac)) return 'maxWidthFrac must be a finite number';
    if (r.maxWidthFrac < 0.1 || r.maxWidthFrac > 1) return 'maxWidthFrac must be within 0.1–1';
  }
  return null;
}

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
      const err = validateCardRequest(req.body);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
      const b = req.body as Partial<CardRequest>;
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
