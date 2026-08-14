import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { tmpDir } from './tmp.js';

/**
 * ============================================================================
 * MCP 工具面的 snapshot 閘門
 * ============================================================================
 *
 * 為什麼存在
 * ----------
 * CLAUDE.md 鐵則：「改了工具行為或語意，必須同步更新 `server/src/mcp.ts` 的工具描述與
 * instructions —— MCP 描述是 AI 使用者唯一的文件。」這條以前**純靠自覺**，而且有失守
 * 前科（get_frame 的描述殘留 roadmap 字句，AI 因此誤判 overlay 沒設定成功）。
 *
 * 這份測試把整個工具面（工具名、description、inputSchema、outputSchema、annotations，
 * 加上 server 級 instructions）鎖進 checked-in snapshot。**任何**改動都會讓它轉紅，
 * 逼改的人在更新 snapshot 之前重新看一次那段描述。
 *
 * ⚠️ 這是**機械閘門，不是語意檢查**。它擋的是「忘了看」，擋不了「看了但寫錯」——
 * 描述寫得對不對仍然只能靠人。跑 `-u` 之前請真的把 diff 讀完。
 *
 * 與鄰居測試的分工
 * ----------------
 * - `mcp-tools.test.ts`  —— 驗個別工具的**行為**
 * - `mcp-docs-sync.test.ts` —— 驗「有沒有工具漏註冊 / 沒寫進 instructions」（面的完整性）
 * - 這一份            —— 驗「面的**逐字內容**有沒有在無人察覺的情況下變了」
 *
 * 取得路徑刻意沿用 `mcp-docs-sync.test.ts`：createMcpServer → InMemoryTransport →
 * `client.listTools()`。**不是**去 parse `mcp.ts` 的原始碼——走真的 MCP 協定才能鎖到
 * client 實際收到的東西（含 zod → JSON Schema 的轉換結果）。原始碼比對會在「工具註冊了
 * 但沒真的送到 client」這種情況下照樣綠。
 *
 * 範圍：只鎖**未設 VIDCUT_CLOUD 的開源面**。這個分支（開源線 main）沒有 cloud 程式碼，
 * `VIDCUT_CLOUD` 在整個 repo 找不到任何 reference，所以此刻工具面只有一種。商業線
 * （vidcut-pro 的 cloud-p0）若讓該變數改變工具面，那邊要自己補一份 cloud 面的 snapshot；
 * 這裡不做條件分支，免得開源版長出一個永遠不會被執行的空殼。
 *
 * 決定性：實測同機兩個獨立行程各自 dump 一次，**逐位元組相同**（cmp 無差異）。
 * 面裡沒有時間戳、沒有隨機值，也沒有洩漏 projectDir／baseUrl（兩者是 closure 捕獲給
 * 執行期用的，不進描述也不進 schema——已 grep 確認 0 次出現）。
 */

/** snapshot 檔案位置（與本檔同層的 __snapshots__/）。 */
const SNAPSHOT_PATH = fileURLToPath(
  new URL('./__snapshots__/mcp-surface.snap.json', import.meta.url),
);

/** 測試紅掉時印在每個斷言後面的行動指引。 */
const UPDATE_HINT =
  '\n' +
  '────────────────────────────────────────────────────────────────────────\n' +
  '這是**刻意的閘門**，不是壞掉的測試。\n' +
  'MCP 工具面（描述／schema／instructions）是 AI 使用者唯一的文件，CLAUDE.md 鐵則\n' +
  '要求「改了工具行為或語意就要同步更新描述」——這份 snapshot 讓「忘了看」變成紅燈。\n' +
  '\n' +
  '如果上面的 diff 正是你這次要做的改動：\n' +
  '  1. 先把 diff 逐條讀完，確認 mcp.ts 的 description 與 instructions 都已經跟\n' +
  '     實際行為對齊（尤其是被你改掉語意的那個工具，還有 instructions 裡提到它的段落）。\n' +
  '  2. 再更新 snapshot：\n' +
  '\n' +
  '       npm test -w @vidcut/server -- -u mcp-surface-snapshot\n' +
  '\n' +
  '  3. 把更新後的 snapshot 一起 commit（它是 checked-in 的，不是產物）。\n' +
  '\n' +
  '如果你**沒有**打算改工具面，那這個紅燈就是它該叫的地方：你改到的東西外溢到了\n' +
  'AI 看得見的介面上，回去看一下是不是預期的。\n' +
  '────────────────────────────────────────────────────────────────────────';

/**
 * 遞迴排序物件鍵。JSON Schema 的鍵順序來自 zod 的物件字面量順序，語意上無意義——
 * 不正規化的話，把 `description` 挪到 `minimum` 前面這種純風格調整就會讓 snapshot
 * 假紅，而假紅久了就會被習慣性 `-u`，閘門也就廢了。陣列順序**保留**（`required`、
 * `enum` 的順序對 client 是有意義的，而且工具的註冊順序本身也值得鎖）。
 */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** 工具面裡我們要鎖的欄位。SDK 自己注入的 `execution` / `_meta` 不鎖——見下方測試。 */
interface ToolFacet {
  name: string;
  description?: string;
  annotations?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

let dir: string;
let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
let instructions: string;

beforeAll(async () => {
  dir = await tmpDir('vidcut-mcpsnap-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
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
  const client = new Client({ name: 'snapshot', version: '0' });
  await client.connect(ct);
  tools = (await client.listTools()).tools;
  instructions = client.getInstructions() ?? '';
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 從 listTools 的結果組出要鎖的面（丟掉 SDK 注入欄位，鍵遞迴排序）。 */
function buildSurface() {
  return {
    instructions,
    tools: tools.map((t) => {
      const facet: ToolFacet = { name: t.name };
      if (t.description !== undefined) facet.description = t.description;
      if (t.annotations !== undefined) facet.annotations = t.annotations;
      if (t.inputSchema !== undefined) facet.inputSchema = t.inputSchema;
      if (t.outputSchema !== undefined) facet.outputSchema = t.outputSchema;
      return sortDeep(facet);
    }),
  };
}

describe('MCP 工具面 snapshot（鐵則的機械閘門）', () => {
  it('整個工具面與 checked-in snapshot 逐字相符', async () => {
    // toMatchFileSnapshot 而不是 inline/`.snap`：這份 snapshot 是「AI 看到的文件」，
    // 應該能被人直接打開閱讀、被 code review 逐行 diff。存成獨立的 .json 檔就是一份
    // 可讀的產物；塞進 vitest 預設的 `.snap`（JS 字串字面量、跳脫字元滿天飛）在
    // 86KB 這個量級下完全不可讀，而不可讀的 snapshot 沒有人會真的審。
    //
    // ⚠️ 第二個參數是 **snapshot 名稱**、不是失敗訊息——把指引塞進去只會讓標題變成
    // 一整面橫幅（實測過）。行動指引改由下面幾條細粒度斷言負責，它們本來就更會定位。
    await expect(JSON.stringify(buildSurface(), null, 2) + '\n').toMatchFileSnapshot(SNAPSHOT_PATH);
  });

  /**
   * 上面那條紅掉時，vitest 印的是整份 86KB 的 diff——量太大時人會看不出「到底哪個工具
   * 變了」。這幾條把粒度拆細，讓錯誤訊息直接點名工具與欄位。
   */
  describe('細粒度定位（讓紅燈說得出是哪個工具的哪個欄位變了）', () => {
    interface Snapshot {
      instructions: string;
      tools: {
        name: string;
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
      }[];
    }
    let saved: Snapshot | null = null;

    beforeAll(async () => {
      // snapshot 不存在（第一次跑，或剛被刪掉）時，上面那條會負責寫出來並通過；
      // 這幾條就沒有比對對象，直接跳過而不是假裝有意見。
      saved = await readFile(SNAPSHOT_PATH, 'utf8')
        .then((s) => JSON.parse(s) as Snapshot)
        .catch(() => null);
    });

    it('工具清單（名稱與順序）沒變', () => {
      if (!saved) return;
      const now = tools.map((t) => t.name);
      const was = saved.tools.map((t) => t.name);
      const added = now.filter((n) => !was.includes(n));
      const removed = was.filter((n) => !now.includes(n));
      expect(
        now,
        `工具清單變了：新增 [${added.join(', ')}]、移除 [${removed.join(', ')}]。\n` +
          `新增工具請一併確認 instructions 有介紹它（mcp-docs-sync.test.ts 會另外驗）。` +
          UPDATE_HINT,
      ).toEqual(was);
    });

    it('每個工具的 description 沒變', () => {
      if (!saved) return;
      const wasByName = new Map(saved.tools.map((t) => [t.name, t]));
      const changed = tools
        .filter(
          (t) => wasByName.has(t.name) && t.description !== wasByName.get(t.name)!.description,
        )
        .map((t) => t.name);
      expect(
        changed,
        `這些工具的 description 變了：${changed.join(', ')}\n` +
          changed
            .map(
              (n) =>
                `\n── ${n} ──\n舊：${wasByName.get(n)!.description}\n新：${
                  tools.find((t) => t.name === n)!.description
                }`,
            )
            .join('\n') +
          UPDATE_HINT,
      ).toEqual([]);
    });

    it('每個工具的 inputSchema / outputSchema 沒變', () => {
      if (!saved) return;
      const wasByName = new Map(saved.tools.map((t) => [t.name, t]));
      const changed: string[] = [];
      for (const t of tools) {
        const w = wasByName.get(t.name);
        if (!w) continue;
        if (JSON.stringify(sortDeep(t.inputSchema)) !== JSON.stringify(w.inputSchema))
          changed.push(`${t.name}.inputSchema`);
        if (JSON.stringify(sortDeep(t.outputSchema)) !== JSON.stringify(w.outputSchema))
          changed.push(`${t.name}.outputSchema`);
      }
      expect(
        changed,
        `這些 schema 變了：${changed.join(', ')}\n` +
          `schema 是 AI 唯一能看到的參數形狀——欄位改名／新增／變必填，都要確認對應工具的\n` +
          `description 有跟著講清楚。` +
          UPDATE_HINT,
      ).toEqual([]);
    });

    it('server 級 instructions 沒變', () => {
      if (!saved) return;
      expect(
        instructions,
        `server instructions 變了（這是 AI 認識整個工具面的唯一入口）。` + UPDATE_HINT,
      ).toBe(saved.instructions);
    });

    /**
     * 兜底：上面幾條各自只看一個欄位，`annotations`（readOnlyHint／title 等）就沒人管。
     * 這條比對整份序列化結果，確保「面變了但沒有任何一條細粒度斷言叫」不會發生——
     * 也讓行動指引在只有 annotations 改動時仍然印得出來。
     */
    it('整份面（含 annotations 等未被上面涵蓋的欄位）沒變', async () => {
      if (!saved) return;
      const now = JSON.stringify(buildSurface(), null, 2) + '\n';
      const was = await readFile(SNAPSHOT_PATH, 'utf8');
      expect(
        now === was,
        `工具面與 snapshot 不符。若上面幾條細粒度斷言都是綠的，那變的就是它們沒涵蓋的\n` +
          `欄位（annotations 的 readOnlyHint／title 之類）。完整 diff 見「整個工具面與\n` +
          `checked-in snapshot 逐字相符」那條。` +
          UPDATE_HINT,
      ).toBe(true);
    });
  });

  /**
   * 決定性自檢。snapshot 閘門的價值完全建立在「同樣的程式碼 → 同樣的位元組」上；
   * 一旦面裡混進時間戳或隨機值，測試就會隨機紅，而隨機紅的閘門會在三天內被停用。
   */
  it('工具面是決定性的（同一份面連續序列化兩次逐位元組相同）', () => {
    expect(JSON.stringify(buildSurface())).toBe(JSON.stringify(buildSurface()));
  });

  it('工具面不含環境相依的值（tmp 專案路徑、baseUrl）', () => {
    const blob = JSON.stringify(buildSurface());
    // 這兩個是 McpDeps 裡唯一與環境有關的輸入。它們外洩到描述或 schema 裡，snapshot
    // 就會在別台機器上紅——而且是那種「重跑就好」的假紅，最容易把閘門磨鈍。
    expect(blob, `工具面洩漏了測試用的專案暫存路徑 ${dir}`).not.toContain(dir);
    expect(
      blob,
      '工具面洩漏了 baseUrl（應該只在執行期回覆裡出現，不該進描述或 schema）',
    ).not.toContain('http://127.0.0.1:3845');
  });

  /**
   * 這份 snapshot 刻意**不鎖** SDK 自己注入的欄位（目前是 `execution`）。理由：那是
   * @modelcontextprotocol/sdk 的版本產物，不是我們寫的文件；鎖了它等於每次升 SDK 都要
   * 假裝「工具描述改了」而跑一次 `-u`，久了就會養成不看 diff 直接 -u 的習慣。
   *
   * 但也不能默默忽略：這條確認被丟掉的欄位**只有**已知的那些。SDK 哪天開始注入一個
   * 真的會影響 AI 的欄位（例如某種 hint），這裡會紅，逼人決定要不要納入鎖定範圍。
   */
  it('listTools 的欄位集合沒有出現未知欄位（SDK 升級時要重新決定鎖定範圍）', () => {
    const LOCKED = ['name', 'description', 'annotations', 'inputSchema', 'outputSchema'];
    // 已知但刻意不鎖的 SDK 注入欄位。
    const IGNORED = ['execution', '_meta', 'title'];
    const seen = [...new Set(tools.flatMap((t) => Object.keys(t)))].sort();
    const unknown = seen.filter((k) => !LOCKED.includes(k) && !IGNORED.includes(k));
    expect(
      unknown,
      `listTools 回了沒見過的欄位：${unknown.join(', ')}\n` +
        `多半是 @modelcontextprotocol/sdk 升級帶來的。請判斷它會不會影響 AI 對工具的理解：\n` +
        `會 → 加進 buildSurface() 一起鎖；不會 → 加進 IGNORED 並寫下理由。`,
    ).toEqual([]);
  });
});
