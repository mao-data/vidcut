import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ProjectStore } from './store.js';
import { listSource } from './sourceFolder.js';
import { ingestMedia } from './ingest.js';
import { applyCommand } from './commands.js';

/**
 * HTTP 面：/api/project（debug）、/media/*（原生 Range，給 <video>）、
 * POST /assets（UI 上傳疊圖等素材）、/（UI build，存在時）。
 */
export function createApp(
  store: ProjectStore,
  projectDir: string,
  uiDistDir?: string,
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

  app.use('/media', express.static(projectDir, { fallthrough: false }));
  if (uiDistDir && existsSync(uiDistDir)) app.use(express.static(uiDistDir));
  return app;
}
