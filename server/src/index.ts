import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { attachWs } from './wsHub.js';
import { ProjectStore } from './store.js';
import { EditorContext } from './editorContext.js';
import { ReviewManager } from './reviews.js';
import { mountMcp } from './mcp.js';
import { PillowRasterizer } from './rasterizer.js';
import { loadFontTable, fontResolver } from './fonts.js';
import { TextCardService } from './textCards.js';
import { CaptionCardSync } from './cardSync.js';

const DEFAULT_PORT = 3845;

export interface StartedServer {
  server: Server;
  store: ProjectStore;
  editorContext: EditorContext;
  reviews: ReviewManager;
}

export async function startServer(projectDir: string, port = DEFAULT_PORT): Promise<StartedServer> {
  const store = await ProjectStore.load(join(projectDir, 'project.json'));
  const editorContext = new EditorContext();
  const reviews = new ReviewManager(store);
  const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui/dist');

  // 字型表：resolver 循環——先用空 resolver 建 rasterizer 來 probe 字型，表建好後回頭換上真 resolver。
  const rasterizer = new PillowRasterizer(() => undefined);
  const fonts = await loadFontTable(rasterizer);
  rasterizer.resolveFontPath = fontResolver(fonts);
  const textCards = new TextCardService(projectDir, rasterizer);
  const cardSync = new CaptionCardSync(store, textCards);

  const app = createApp(store, projectDir, uiDist, { fonts, textCards });
  // MCP 需要能讀 req.body（JSON），StreamableHTTP 會自己處理 SSE。
  const server = createServer(app);
  attachWs(server, { store, editorContext, reviews, projectDir, cardSync });

  // baseUrl 在 listen 後才知道實際 port；先用預留位，listen 後補。
  const deps = { store, projectDir, editorContext, reviews, baseUrl: `http://127.0.0.1:${port}` };
  mountMcp(app, deps);

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  deps.baseUrl = `http://127.0.0.1:${actualPort}`;
  cardSync.schedule(); // 啟動預熱字卡快取(錯誤已在 runNow 內吞,不會拖垮啟動)
  return { server, store, editorContext, reviews };
}

// CLI: tsx src/index.ts <projectDir>
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: dev -- <projectDir>');
    process.exit(1);
  }
  const absDir = resolve(dir);
  // 防呆：路徑打錯時會靜默開一個空專案，很難察覺——明確告知
  if (!existsSync(join(absDir, 'project.json'))) {
    console.warn(`⚠ ${join(absDir, 'project.json')} 不存在，將建立新的空專案。`);
    console.warn('  若你想開既有專案，請確認路徑（相對路徑是相對於你執行指令的目錄）。');
  }
  const { server, store } = await startServer(absDir);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT;
  console.log(`vidcut server on http://127.0.0.1:${port}  (MCP at /mcp)`);
  console.log(`專案：${absDir}（${store.doc.tracks.video.length} 個片段）`);
}
