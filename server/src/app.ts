import express from 'express';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { ProjectStore } from './store.js';
import { listSource, MEDIA_EXTENSIONS } from './sourceFolder.js';
import { ingestMedia } from './ingest.js';
import { applyCommand } from './commands.js';
import type { FontEntry } from './fonts.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';
import { cardRequestError } from './cardBudget.js';
import type { LibraryStore } from './libraryStore.js';
import { addToLibrary, prepareFromLibrary, discardPrepared } from './libraryIngest.js';

/**
 * POST /text-card/preview 的手寫 body 驗證（故意不用 zod）：回 null 代表通過，否則回錯誤訊息。
 *
 * 這裡只做**型別/形狀**檢查；「這張卡會不會大到把 worker 撐爆」的判斷一律交給
 * cardBudget 的 cardRequestError——那是所有產卡路徑（本端點、cardSync、文字 overlay 前置）
 * 共用的同一份規則。以前上限只寫在這個 handler 裡，於是會落盤的那兩條路徑完全沒有上限。
 *
 * width 要帶預設值進來一起驗：body 省略 width 時實際送給 Pillow 的是畫布寬，
 * 驗一個 undefined 等於沒驗。
 */
function validateCardRequest(b: unknown, defaultWidth: number): string | null {
  if (!b || typeof b !== 'object') return 'need text + style';
  const r = b as Partial<CardRequest>;
  if (typeof r.text !== 'string') return 'text must be a string';
  if (!r.style || typeof r.style !== 'object') return 'style is required';
  const s = r.style as Partial<CardRequest['style']>;
  if (typeof s.fontFamily !== 'string' || s.fontFamily === '')
    return 'style.fontFamily must be a non-empty string';
  if (typeof s.fontSize !== 'number' || !Number.isFinite(s.fontSize) || s.fontSize <= 0)
    return 'style.fontSize must be a finite number > 0';
  if (typeof s.fill !== 'string' || s.fill === '') return 'style.fill must be a non-empty string';
  if (s.stroke !== undefined && typeof s.stroke !== 'string')
    return 'style.stroke must be a string';
  if (s.highlight !== undefined && typeof s.highlight !== 'string')
    return 'style.highlight must be a string';
  if (
    r.tokens !== undefined &&
    (!Array.isArray(r.tokens) || !r.tokens.every((t) => typeof t === 'string'))
  )
    return 'tokens must be an array of strings';
  if (r.width !== undefined && (typeof r.width !== 'number' || !Number.isFinite(r.width)))
    return 'width must be a finite number';
  return cardRequestError({ ...(r as CardRequest), width: r.width ?? defaultWidth });
}

/**
 * HTTP 面：/api/project（debug）、/api/fonts+/fonts/:id（字型表，供 UI @font-face）、
 * /media/*（原生 Range，給 <video>）、POST /assets（UI 上傳疊圖等素材）、/（UI build，存在時）。
 */
export function createApp(
  store: ProjectStore,
  projectDir: string,
  uiDistDir?: string,
  extras?: { fonts?: FontEntry[]; textCards?: TextCardService; library?: LibraryStore },
): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/api/project', (_req, res) => {
    res.json({ version: store.version, doc: store.doc });
  });

  // 素材夾掃描（零複製匯入的挑檔來源）。綁 127.0.0.1，故不做根目錄白名單，
  // 但仍只回白名單副檔名、排除隱藏檔、不遞迴。
  app.get('/api/source', (req, res, next) => {
    void (async () => {
      const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
      if (!dir) {
        res.status(400).json({ error: 'need ?dir=' });
        return;
      }
      try {
        res.json(await listSource(dir, store.doc.media, projectDir));
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    })().catch(next);
  });

  // 匯入素材：零複製引用原檔，只在專案內產衍生檔。
  // ffmpeg 一支動輒數秒到數分鐘，逐支序列處理（並行只會互搶 CPU）。
  app.post('/api/import', (req, res, next) => {
    void (async () => {
      const { dir, names, addToTimeline } = req.body as {
        dir?: string;
        names?: string[];
        addToTimeline?: boolean;
      };
      if (!dir || !Array.isArray(names) || names.length === 0) {
        res.status(400).json({ error: 'need dir and names[]' });
        return;
      }
      const ok: Array<{ name: string; mediaId: string }> = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const name of names) {
        try {
          const abs = join(dir, basename(name)); // basename 防 traversal
          const mediaId = await ingestMedia(store, projectDir, abs, { label: name });
          if (addToTimeline) {
            const media = store.doc.media.find((m) => m.id === mediaId)!;
            const r = applyCommand(store, 'human', {
              name: 'addClip',
              mediaId,
              in: 0,
              duration: media.probe.duration,
              label: name,
            });
            if (!r.ok) throw new Error(r.error);
          }
          ok.push({ name, mediaId });
        } catch (e) {
          failed.push({ name, error: (e as Error).message });
        }
      }
      res.json({ ok, failed });
    })().catch(next);
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

  // ── 跨專案素材庫（spec 2026-08-21）。lib 未載入（索引損毀降級）時一律 503。 ──
  const lib = extras?.library;
  const q = (req: express.Request, k: string): string | undefined =>
    typeof req.query[k] === 'string' && req.query[k] !== '' ? (req.query[k] as string) : undefined;

  app.get('/api/library', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      // 這個工作區常態多 session 同開：讀入口先 reload 才看得到別的 session 剛入庫的 asset
      await lib.reload();
      res.json({ assets: lib.list({ query: q(req, 'query'), tag: q(req, 'tag') }) });
    })().catch(next);
  });

  // 上傳入庫。串流落地暫存檔再 move 入庫——不走 express.raw：300MB 檔 arrayBuffer
  // 路徑會吃 300MB RSS（ROADMAP「上傳路徑串流化」實測），庫素材（片頭/BGM）就是這個量級。
  app.post('/api/library', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      const clean = basename(q(req, 'name') ?? '');
      const ext = extname(clean).toLowerCase();
      if (!clean || !(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
        res.status(400).json({
          error: `need ?name= with a supported extension (${MEDIA_EXTENSIONS.join(' ')})`,
        });
        return;
      }
      const tmp = join(lib.dir, `.upload-${nanoid(8)}${ext}`);
      try {
        await pipeline(req, createWriteStream(tmp));
        const r = await addToLibrary(lib, tmp, {
          label: q(req, 'label') ?? clean, // move 路徑暫存檔名不是原檔名，label 一定要在這層給
          tags: q(req, 'tags')?.split(',') ?? [],
          origin: { type: 'upload', note: clean },
          move: true,
        });
        res.json(r);
      } catch (e) {
        await rm(tmp, { force: true });
        res.status(400).json({ error: (e as Error).message });
      }
    })().catch(next);
  });

  // 錯誤字樣 `no library asset` ⇒ 404（LibraryStore 的約定），其餘 400
  const libErr = (res: express.Response, e: unknown) => {
    const msg = (e as Error).message;
    res.status(msg.startsWith('no library asset') ? 404 : 400).json({ error: msg });
  };

  app.patch('/api/library/:id', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      const { label, tags } = (req.body ?? {}) as { label?: unknown; tags?: unknown };
      if (label !== undefined && typeof label !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      if (
        tags !== undefined &&
        (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string'))
      ) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }
      try {
        // 驗證過了才收窄型別——上面兩個 if 就是 narrowing 的證據
        res.json({
          asset: await lib.updateAsset(req.params.id, {
            label: label as string | undefined,
            tags: tags as string[] | undefined,
          }),
        });
      } catch (e) {
        libErr(res, e);
      }
    })().catch(next);
  });

  app.delete('/api/library/:id', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      try {
        await lib.removeAsset(req.params.id);
        res.json({ ok: true });
      } catch (e) {
        libErr(res, e);
      }
    })().catch(next);
  });

  app.post('/api/library/:id/import', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      const { addToTimeline } = (req.body ?? {}) as { addToTimeline?: boolean };
      try {
        const prepared = await prepareFromLibrary(store, projectDir, lib, req.params.id);
        let mediaId: string;
        if ('existingId' in prepared) {
          mediaId = prepared.existingId;
        } else {
          const r = applyCommand(store, 'human', { name: 'registerMedia', asset: prepared.asset });
          if (!r.ok) {
            // 登記失敗：prepareFromLibrary 已經把 derived/<id>/ cp 進專案了，不清會留孤兒目錄
            await discardPrepared(projectDir, prepared.asset);
            throw new Error(r.error);
          }
          mediaId = prepared.asset.id;
        }
        if (addToTimeline) {
          const media = store.doc.media.find((m) => m.id === mediaId)!;
          const r = applyCommand(store, 'human', {
            name: 'addClip',
            mediaId,
            in: 0,
            duration: media.probe.duration,
            label: media.label,
          });
          if (!r.ok) {
            // 素材已登記、只有上軌失敗（audio-only 走到這）——mediaId 一起回，別讓呼叫端誤以為全失敗
            res.status(400).json({ error: r.error, mediaId });
            return;
          }
        }
        res.json({ mediaId });
      } catch (e) {
        libErr(res, e);
      }
    })().catch(next);
  });

  if (lib) {
    // files/ 內容定址：URL 變 = 內容變 ⇒ 強快取；derived/ 會被 lazy 重建（同 URL 換內容），不能 immutable
    app.use(
      '/library/files',
      express.static(join(lib.dir, 'files'), {
        fallthrough: false,
        immutable: true,
        maxAge: '365d',
      }),
    );
    app.use('/library/derived', express.static(join(lib.dir, 'derived'), { fallthrough: false }));
  }

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
      const err = validateCardRequest(req.body, store.doc.canvas.width);
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
