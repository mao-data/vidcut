import express from 'express';
import { existsSync } from 'node:fs';
import type { ProjectStore } from './store.js';

/**
 * HTTP 面：/api/project（debug）、/media/*（原生 Range，給 <video>）、
 * / （UI build，存在時）。
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
  app.use('/media', express.static(projectDir, { fallthrough: false }));
  if (uiDistDir && existsSync(uiDistDir)) app.use(express.static(uiDistDir));
  return app;
}
