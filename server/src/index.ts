import { createServer, type Server } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { attachWs } from './wsHub.js';
import { ProjectStore } from './store.js';
import { EditorContext } from './editorContext.js';
import { ReviewManager } from './reviews.js';
import { mountMcp } from './mcp.js';

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

  const app = createApp(store, projectDir, uiDist);
  // MCP 需要能讀 req.body（JSON），StreamableHTTP 會自己處理 SSE。
  const server = createServer(app);
  attachWs(server, { store, editorContext, reviews });

  // baseUrl 在 listen 後才知道實際 port；先用預留位，listen 後補。
  const deps = { store, projectDir, editorContext, reviews, baseUrl: `http://127.0.0.1:${port}` };
  mountMcp(app, deps);

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  deps.baseUrl = `http://127.0.0.1:${actualPort}`;
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
  const { server } = await startServer(resolve(dir));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT;
  console.log(`vidcut server on http://127.0.0.1:${port}  (MCP at /mcp)`);
}
