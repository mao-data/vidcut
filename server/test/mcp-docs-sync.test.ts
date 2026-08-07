import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { makeVideo } from './fixtures.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { tmpDir } from './tmp.js';

/**
 * MCP「面的完整性」守衛。與 mcp-tools.test.ts 的差別：那邊驗個別工具的行為，
 * 這邊驗「有沒有工具漏掉、有沒有工具沒寫進文件」。
 *
 * 存在的理由是 CLAUDE.md 的鐵則第三步（registerTool + 同步 instructions 不會自動
 * 發生）。舊守衛硬編 6 個工具名做 toContain，工具真的沒註冊時照樣綠，等於沒守。
 */
const INSTRUCTIONS_EXEMPT: Record<string, string> = {
  get_project:
    '唯讀查詢工具，描述已自足（取得專案裁剪總覽，clips/captions/media/version/review）；' +
    '不改狀態、不依賴特定呼叫順序，AI 隨時可呼叫，不屬於流程敘事需要教的步驟。',
  get_history:
    '唯讀查詢工具，描述已自足（最近的變更記錄）；不改狀態、不依賴特定流程順序，' +
    '不屬於編輯流程步驟。',
  undo:
    '通用復原操作（語意等同 Ctrl-Z，不需要 instructions 教它存在），不屬於特定編輯' +
    '流程的步驟；唯一需要特別交代的風險（undo 堆疊與人共用）已寫在工具描述本身。',
  redo:
    '通用重做操作，undo 的反向；理由同 undo——不屬於流程步驟，堆疊共用的警語已在' +
    '工具描述本身交代。',
};

let dir: string;
let store: ProjectStore;
let client: Client;

beforeAll(async () => {
  dir = await tmpDir('vidcut-mcpdocs-');
  await makeVideo(dir, 'a.mp4', { duration: 6 });
  store = await ProjectStore.load(join(dir, 'project.json'));
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews: new ReviewManager(store, 900_000),
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
  };
  const server = createMcpServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('MCP 面的完整性', () => {
  it('每個註冊的工具都出現在 instructions 裡，或有明列的豁免理由', async () => {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(0);

    const undocumented = tools
      .map((t) => t.name)
      .filter((n) => !instructions.includes(n) && !(n in INSTRUCTIONS_EXEMPT));

    expect(
      undocumented,
      `這些工具既沒寫進 instructions、也沒列進 INSTRUCTIONS_EXEMPT：${undocumented.join(', ')}\n` +
        `AI 使用者只能靠 instructions 認識工具面——要嘛把它寫進去，要嘛在豁免表裡寫下理由。`,
    ).toEqual([]);
  });

  it('豁免清單不得列入不存在的工具（清單自己也會過期）', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const stale = Object.keys(INSTRUCTIONS_EXEMPT).filter((n) => !names.has(n));
    expect(stale, `豁免清單裡這些工具已經不存在：${stale.join(', ')}`).toEqual([]);
  });

  it('instructions 說明了純音訊素材的軌道限制', () => {
    expect(client.getInstructions() ?? '').toMatch(/純音訊/);
  });

  it('instructions 提到的工具名都真的註冊了（防止描述留在文件裡、實作已移除）', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const instructions = client.getInstructions() ?? '';
    // instructions 裡形如 snake_case 且長度 >= 4 的詞，視為工具名候選
    const mentioned = [...new Set(instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
    const ghosts = mentioned.filter((n) => !names.has(n));
    expect(ghosts, `instructions 提到但實際沒註冊的工具：${ghosts.join(', ')}`).toEqual([]);
  });
});
