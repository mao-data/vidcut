import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Command } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { makeVideo } from './fixtures.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { tmpDir } from './tmp.js';

/**
 * 從 Command 聯集型別取出所有 name。這是編譯期檢查：任何 variant 新增或改名，
 * 而這份清單沒跟上，tsc 就會失敗（Record 的鍵不完整）——不會靜默漏掉。
 */
const COMMAND_VARIANT_MAP: Record<Command['name'], true> = {
  updateClip: true,
  reorderClips: true,
  removeClip: true,
  addClip: true,
  setTimeline: true,
  updateOverlay: true,
  updateCaption: true,
  setOverlays: true,
  addOverlay: true,
  removeOverlay: true,
  setCaptions: true,
  splitAt: true,
  deleteBefore: true,
  deleteAfter: true,
  freezeFrame: true,
  extractAudio: true,
  updateAudio: true,
  removeAudio: true,
  setAudio: true,
  setCanvasFit: true,
  setCanvas: true,
  registerMedia: true,
  updateMediaDerived: true,
  setCover: true,
  setPublish: true,
  undo: true,
  redo: true,
};
const COMMAND_VARIANTS = Object.keys(COMMAND_VARIANT_MAP);

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
    chat: await ChatStore.load(join(dir, 'chat.json')),
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
    expect(client.getInstructions() ?? '').toMatch(/audio-only/i);
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

/**
 * 鐵則第三步的執行面守衛：Command variant 加了、commands.ts 也加了，但忘記
 * registerTool——AI 就永遠碰不到這個能力。前例：addClip 做完八輪 TDD 卻沒人能用。
 * 第一、二步漏掉會被 tsc 抓到（commands.ts 的 switch 少 case 編不過），只有第三步
 * 從前沒有任何東西擋。
 *
 * ⚠️ 這份表的每一條理由都是自由文字，**沒有任何測試驗證它是真的**——只驗證 key 對得上
 * 現存的 Command variant（見下面「豁免清單不得列入不存在的 variant」），不驗證理由裡
 * 講的那個聚合工具（`timeline_op`／`import_media`）實際上真的把這個 op 接上了。全分支
 * 審查曾實測：把 `deleteBefore` 從 `timeline_op` 的 `z.enum` 與 handler 三元式整條拔掉
 * （＝這條豁免理由變假、`deleteBefore` 從 MCP 永久觸達不到），這裡的測試照樣全線綠燈，
 * `tsc`／443 個測試也全綠——沒有任何關卡會叫。詳見 `docs/ROADMAP.md`「MCP 面補完分支」
 * 一節的待辦。**改動 `timeline_op`／`import_media` 這類聚合工具時，這份表要人工複查**，
 * 不能只看測試綠燈。
 */
const MCP_EXEMPT_COMMANDS: Record<string, string> = {
  splitAt: '由 timeline_op 的 op:"split" 觸達',
  deleteBefore: '由 timeline_op 的 op:"deleteBefore" 觸達',
  deleteAfter: '由 timeline_op 的 op:"deleteAfter" 觸達',
  freezeFrame: '由 timeline_op 的 op:"freeze" 觸達',
  registerMedia: '由 import_media 內部呼叫觸達',
  setPublish: '由 export_publish_package 內部呼叫觸達（Task 4）',
  // ⚠️ **暫時性豁免,不是設計決策。** 多比例畫布這一批刻意把命令層(本任務)與 MCP 工具
  // (後續任務)拆成兩步走,這一格就是那個中間態:命令與驗證已經在,`set_canvas` 工具
  // 還沒註冊。工具一補上就**必須把這條刪掉**——留著等於讓鐵則第三步的守衛對這個
  // variant 永久失效。上面那些豁免講的是「有聚合工具間接觸達」或「刻意不上 MCP」,
  // 跟這條的性質完全不同,不要照抄。
  setCanvas: '多比例畫布分批實作的中間態:命令層先落地,set_canvas 工具由後續任務補上',
  updateMediaDerived:
    '刻意連間接路徑都沒有——背景 ingest pipeline（Plan 8 A1/A2 階段）內部呼叫' +
    'applyCommand 寫回 derived 檔欄位，不經過任何 MCP 工具（不像 registerMedia' +
    '有 import_media 頂著）。這是鐵則三的顯式豁免，見 commands.ts 該 case 的註解。',
};

describe('Command variant 都能從 MCP 觸達', () => {
  it('每個 Command variant 都有對應的 MCP 工具，或有明列的豁免理由', async () => {
    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((t) => t.name));
    // camelCase variant → snake_case 工具名（addClip → add_clip）
    const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

    const unreachable = COMMAND_VARIANTS.filter(
      (v) => !toolNames.has(toSnake(v)) && !(v in MCP_EXEMPT_COMMANDS),
    );

    expect(
      unreachable,
      `這些 Command variant 沒有對應的 MCP 工具，也沒列進豁免表：${unreachable.join(', ')}\n` +
        `＝ AI 永遠碰不到這個能力（CLAUDE.md 鐵則第三步）。`,
    ).toEqual([]);
  });

  it('豁免清單不得列入不存在的 variant', () => {
    const stale = Object.keys(MCP_EXEMPT_COMMANDS).filter((v) => !COMMAND_VARIANTS.includes(v));
    expect(stale, `豁免清單裡這些 variant 已經不存在：${stale.join(', ')}`).toEqual([]);
  });
});
