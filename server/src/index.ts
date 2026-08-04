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
import { loadFontTable, fontResolver, type FontEntry } from './fonts.js';
import { setCaptionFontResolver } from './render.js';
import { TextCardService } from './textCards.js';
import { CaptionCardSync } from './cardSync.js';

/**
 * 預設 :3845。`VIDCUT_PORT` 可覆寫——為的是「同時再起第二個 server 吃另一個專案」
 * 這個需求（例如 `npm run verify:wysiwyg` 要用自己的臨時專案跑一次真渲染，
 * 不能碰使用者手上那台 :3845 與 `projects/demo`）。壞值（非數字/超範圍）一律
 * 退回 3845，不要讓一個打錯的環境變數變成 `listen(NaN)` 那種難懂的失敗。
 */
const DEFAULT_PORT = (() => {
  const raw = Number(process.env.VIDCUT_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 3845;
})();

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
  // loadFontTable 會真的跑 python3 去 probe 字型。python3 不在 PATH 上（或 Pillow 沒裝）時
  // 這一步會失敗——而它在 listen() 之前，讓它冒出去等於整個 server 起不來、連 UI 都打不開，
  // 只為了一個「字幕比較好看」的附屬功能。降級成空字型表：字卡產不出來，字幕預覽退回
  // DOM 近似、匯出走原本的無字卡路徑，其餘功能（時間軸、播放、渲染、MCP）完全正常。
  let fonts: FontEntry[] = [];
  try {
    fonts = await loadFontTable(rasterizer);
  } catch (e: unknown) {
    console.warn(`⚠ 字卡光柵器無法啟動，字幕/文字 overlay 的字卡功能停用：${(e as Error).message}`);
    console.warn('  需要 PATH 上有 python3 且已安裝 Pillow（pip3 install pillow）。');
    console.warn('  server 仍會正常啟動；字幕預覽會退回 DOM 近似顯示。');
  }
  const resolveFont = fontResolver(fonts);
  rasterizer.resolveFontPath = resolveFont;
  setCaptionFontResolver(resolveFont);
  const textCards = new TextCardService(projectDir, rasterizer);
  const cardSync = new CaptionCardSync(store, textCards);

  const app = createApp(store, projectDir, uiDist, { fonts, textCards });
  // MCP 需要能讀 req.body（JSON），StreamableHTTP 會自己處理 SSE。
  const server = createServer(app);
  attachWs(server, { store, editorContext, reviews, projectDir, cardSync, textCards });

  // baseUrl 在 listen 後才知道實際 port；先用預留位，listen 後補。
  const deps = {
    store,
    projectDir,
    editorContext,
    reviews,
    baseUrl: `http://127.0.0.1:${port}`,
    textCards,
  };
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
