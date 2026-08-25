import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { attachWs } from './wsHub.js';
import { ProjectStore } from './store.js';
import { ChatStore } from './chatStore.js';
import { EditorContext } from './editorContext.js';
import { ReviewManager } from './reviews.js';
import { mountMcp } from './mcp.js';
import { PillowRasterizer } from './rasterizer.js';
import { loadFontTable, fontResolver, type FontEntry } from './fonts.js';
import { setCaptionFontResolver } from './render.js';
import { TextCardService } from './textCards.js';
import { CaptionCardSync } from './cardSync.js';
import { refreshTextOverlayCards } from './textOverlays.js';
import { LibraryStore } from './libraryStore.js';

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
  chat: ChatStore;
  editorContext: EditorContext;
  reviews: ReviewManager;
}

export async function startServer(projectDir: string, port = DEFAULT_PORT): Promise<StartedServer> {
  const store = await ProjectStore.load(join(projectDir, 'project.json'));
  // 聊天記錄與 project.json 同目錄、各自獨立的檔案。載入永不拋（壞檔＝空清單），
  // 所以這一行不需要 try/catch——理由見 chatStore.ts 檔頭。
  const chat = await ChatStore.load(join(projectDir, 'chat.json'));
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
    console.warn(
      `⚠ Text-card rasterizer unavailable — captions/text overlays lose their cards: ${(e as Error).message}`,
    );
    console.warn('  Needs python3 on PATH with Pillow installed (pip3 install pillow).');
    console.warn(
      '  The server still starts; caption preview falls back to a rough DOM approximation.',
    );
  }
  const resolveFont = fontResolver(fonts);
  rasterizer.resolveFontPath = resolveFont;
  setCaptionFontResolver(resolveFont);
  const textCards = new TextCardService(projectDir, rasterizer);
  const cardSync = new CaptionCardSync(store, textCards);

  // 跨專案素材庫（spec 2026-08-21）。索引損毀時降級成「無素材庫」——素材庫端點回 503、
  // MCP 工具回錯誤，其餘功能（時間軸、播放、渲染）完全正常。不修不清：索引是使用者資料。
  const libraryDir = process.env.VIDCUT_LIBRARY_DIR ?? join(homedir(), '.vidcut', 'library');
  let library: LibraryStore | undefined;
  try {
    library = await LibraryStore.load(libraryDir);
  } catch (e) {
    console.warn(`⚠ Asset library unavailable (${libraryDir}): ${(e as Error).message}`);
    console.warn('  Fix or move the corrupt library.json and restart to re-enable it.');
  }

  const app = createApp(store, projectDir, uiDist, { fonts, textCards, library });
  // MCP 需要能讀 req.body（JSON），StreamableHTTP 會自己處理 SSE。
  const server = createServer(app);
  const wss = attachWs(server, {
    store,
    editorContext,
    reviews,
    projectDir,
    cardSync,
    textCards,
    chat,
  });
  // ws 收到 `{ server }` 時會把 http server 的 'error' 轉發到 wss 上。轉發過來的
  // EADDRINUSE 在 wss 這邊沒有監聽者，Node 就直接丟——這正是從前那十幾行堆疊的來源，
  // 而且它比下面 Promise 的 reject 早到。listen 期間的錯誤由下面統一回報，這裡只吃掉
  // 重複的那一份；其餘（執行期真的出事）照樣要看得見。
  wss.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') console.error('⚠ WebSocket server error:', e);
  });

  // baseUrl 在 listen 後才知道實際 port；先用預留位，listen 後補。
  const deps = {
    store,
    projectDir,
    editorContext,
    reviews,
    baseUrl: `http://127.0.0.1:${port}`,
    textCards,
    chat,
    library,
  };
  mountMcp(app, deps);

  // listen 的 Promise 必須同時接 'error'。只接 callback 的話 EADDRINUSE 會變成
  // 「未處理的 error 事件」——Node 直接印十幾行堆疊然後死掉，裡面沒有一個字提到
  // VIDCUT_PORT。而 port 被占用是這個專案的常態（一個工作區常有好幾台 server）。
  await new Promise<void>((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.close();
      fail(
        e.code === 'EADDRINUSE'
          ? new Error(
              `127.0.0.1:${port} is already in use — most likely another vidcut is running. ` +
                `Stop it, or start on a different port: ` +
                `VIDCUT_PORT=<port> npx tsx server/src/index.ts <projectDir>`,
            )
          : e,
      );
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError); // listen 成功後的 error 交回一般錯誤流程
      ok();
    });
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  deps.baseUrl = `http://127.0.0.1:${actualPort}`;
  cardSync.schedule(); // 啟動預熱字卡快取(錯誤已在 runNow 內吞,不會拖垮啟動)
  // 文字 overlay 的字卡不像字幕會被 cardSync 自動重算——imagePath 烤在 doc 裡，
  // 光柵器版本一變就會指著舊排版的檔案且永遠救不回來。啟動時重解析一次（hash 沒變就
  // 完全不動，所以只有升級後的第一次會做事）。不 await：不拖慢 listen，失敗只記 warn。
  void refreshTextOverlayCards(textCards, store)
    .then((n) => {
      if (n > 0) console.log(`Rasterizer updated: regenerated cards for ${n} text overlay(s)`);
    })
    .catch((e: unknown) =>
      console.warn(`⚠ Failed to re-resolve text-overlay cards: ${(e as Error).message}`),
    );
  return { server, store, chat, editorContext, reviews };
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
    console.warn(
      `⚠ ${join(absDir, 'project.json')} does not exist — creating a new empty project.`,
    );
    console.warn(
      '  To open an existing project, check the path (relative paths resolve from your cwd).',
    );
  }
  // 啟動失敗只印 startServer 給的那句話。堆疊對「port 被占用」這種事毫無幫助，
  // 而它是新手最常撞的第一個坑。
  let started: StartedServer;
  try {
    started = await startServer(absDir);
  } catch (e: unknown) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
  const { server, store } = started;
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT;
  console.log(`vidcut server on http://127.0.0.1:${port}  (MCP at /mcp)`);
  console.log(`Project: ${absDir} (${store.doc.tracks.video.length} clips)`);
}
