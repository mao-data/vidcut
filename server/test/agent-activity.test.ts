import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WsServerMsg } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import {
  agentActivityBus,
  nextCallId,
  resetCallIds,
  type AgentActivityEvent,
} from '../src/agentActivity.js';
import { startServer } from '../src/index.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

/**
 * `agentActivity` 進行中訊號（spec `docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.1）。
 *
 * 這**不是 Command**：不動 doc、不走 applyCommand、不進版本/歷史/undo。它只是
 * 「AI 現在正在跑哪個工具」的暫態旁路，讓 UI 能顯示進行中狀態。
 *
 * 硬性驗收在鄰居 `mcp-surface-snapshot.test.ts`：包裝層只攔執行，**工具面必須逐位元組
 * 不變**（name/description/inputSchema/outputSchema/annotations/instructions 一個字都不能動）。
 */

let dir: string;
let store: ProjectStore;
let client: Client;
/** 這一輪蒐集到的 bus 事件（每個測試前清空）。 */
let seen: AgentActivityEvent[];
const collect = (e: AgentActivityEvent) => seen.push(e);

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

beforeAll(async () => {
  dir = await tmpDir('vidcut-agentact-');
  await makeVideo(dir, 'a.mp4', { duration: 3 });
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
  client = new Client({ name: 'agentact', version: '0' });
  await client.connect(ct);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  agentActivityBus.on('activity', collect);
});
afterEach(() => {
  agentActivityBus.off('activity', collect);
});

describe('callId 序號（B6）', () => {
  it('從 1 起遞增，決定性', () => {
    resetCallIds();
    expect([nextCallId(), nextCallId(), nextCallId()]).toEqual(['1', '2', '3']);
  });

  it('序號是模組級的——不同 McpServer 實例共用（mountMcp 每請求 new 一台）', async () => {
    // 這正是 per-server 計數器會壞掉的情境：兩台 server 各跑一個工具，
    // 若計數器綁在 server 上，兩邊都會拿到 '1'，UI 端的集合就互相蓋掉。
    const mkClient = async () => {
      const deps: McpDeps = {
        store,
        projectDir: dir,
        editorContext: new EditorContext(),
        reviews: new ReviewManager(store, 900_000),
        baseUrl: 'http://127.0.0.1:3845',
        textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
        chat: await ChatStore.load(join(dir, 'chat.json')),
      };
      const s = createMcpServer(deps);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await s.connect(st);
      const c = new Client({ name: 'x', version: '0' });
      await c.connect(ct);
      return c;
    };
    const c1 = await mkClient();
    const c2 = await mkClient();
    await c1.callTool({ name: 'get_project', arguments: {} });
    await c2.callTool({ name: 'get_project', arguments: {} });
    const ids = [...new Set(seen.map((e) => e.callId))];
    expect(ids).toHaveLength(2);
  }, 30_000);
});

describe('start/end 配對（B2/B3/N1）', () => {
  it('工具呼叫廣播 start 然後 end，同一個 callId、同一個工具名', async () => {
    await call('get_project');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ phase: 'start', tool: 'get_project' });
    expect(seen[1]).toMatchObject({ phase: 'end', tool: 'get_project' });
    expect(seen[1].callId).toBe(seen[0].callId);
  });

  it('start 一定在 end 之前（順序，不只是兩則都有）', async () => {
    await call('get_history');
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
  });

  it('連續兩次呼叫拿到不同的 callId（集合才不會互相覆蓋）', async () => {
    await call('get_project');
    await call('get_project');
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end', 'start', 'end']);
    expect(seen[0].callId).not.toBe(seen[2].callId);
  });

  it('每個工具都被包到——不是只有第一個註冊的那個（31 個工具一次涵蓋）', async () => {
    for (const name of ['get_project', 'get_history', 'get_feedback', 'get_editor_context']) {
      seen = [];
      await call(name, name === 'get_feedback' ? { sinceVersion: 0 } : {});
      expect(seen.map((e) => `${e.phase}:${e.tool}`)).toEqual([`start:${name}`, `end:${name}`]);
    }
  });

  it('包裝層不改回傳值（工具結果原樣透傳）', async () => {
    const r = (await call('get_project')) as { structuredContent?: { version?: number } };
    expect(r.structuredContent?.version).toBe(store.version);
  });

  it('回應用 err() 的失敗（isError，不是拋錯）照樣配對 end', async () => {
    // get_frame 在主軌是空的時候回 err()，屬正常回傳路徑。
    const r = (await call('get_frame', { time: 0 })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
  });
});

describe('拋錯路徑（B4/N2）——不得卡假忙碌', () => {
  /**
   * ⚠️ MCP SDK 會**在我們的包裝層外面**把 handler 拋的例外轉成 `{isError:true}` 的
   * 正常回應（`server/mcp.js` 的 `catch (error) → createToolError`）。所以這裡不能斷言
   * `rejects.toThrow()`——第一次寫成那樣時測試紅在「拿到 isError 而不是 rejection」，
   * 那是 SDK 的既有行為，不是我們的 bug。
   *
   * 真正要釘的是兩件事：(a) `finally` 讓 end 照樣發出去（少了它，UI 會在一次失敗的
   * transcribe 之後**永遠**卡在 working）；(b) 例外沒有被包裝層吞掉——錯誤訊息原封不動
   * 傳到呼叫端。所以下面同時斷言 end 有發、以及 isError + ffmpeg 的原始訊息還在。
   */
  it('handler 拋錯時仍廣播 end，而且錯誤照樣往外傳（不被包裝層吞掉）', async () => {
    // 讓 get_frame 真的拋：主軌有 clip 但底下的媒體檔被刪掉 → runFfmpeg 拋。
    const media = await tmpDir('vidcut-agentact-src-');
    await makeVideo(media, 'gone.mp4', { duration: 2 });
    const abs = join(media, 'gone.mp4');
    const { prepareMedia } = await import('../src/ingest.js');
    const prepared = await prepareMedia(store, dir, abs, { label: 'gone' });
    if (!('asset' in prepared)) throw new Error('fixture: expected a fresh import');
    store.mutate('ai', 'fixture', (d) => {
      d.media.push(prepared.asset);
      d.tracks.video = [
        { id: 'c-throw', mediaId: prepared.asset.id, in: 0, duration: 2, volume: 1 },
      ];
    });
    // proxy 與原始檔都砍掉 → ffmpeg 找不到輸入
    await rm(join(dir, 'derived'), { recursive: true, force: true });
    await unlink(abs);

    seen = [];
    const r = (await call('get_frame', { time: 0 })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    // (b) 例外沒被吞：ffmpeg 的原始訊息完整傳到呼叫端
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => c.text ?? '').join('')).toMatch(/ffmpeg exited/);
    // (a) finally 讓 end 照樣發出去
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(seen[1].callId).toBe(seen[0].callId);
    expect(seen[1].tool).toBe('get_frame');

    store.mutate('ai', 'fixture cleanup', (d) => {
      d.tracks.video = [];
    });
    await rm(media, { recursive: true, force: true });
  }, 60_000);
});

describe('傳遞到 WS（B8）', () => {
  it('bus 事件經 wsHub 廣播成 agentActivity 訊息給所有 client', async () => {
    const wsDir = await tmpDir('vidcut-agentact-ws-');
    const { server } = await startServer(wsDir, 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((r, j) => {
        ws.once('open', () => r());
        ws.once('error', j);
      });
      const got: WsServerMsg[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString()) as WsServerMsg));

      agentActivityBus.emit('activity', {
        phase: 'start',
        tool: 'transcribe',
        callId: '42',
      } satisfies AgentActivityEvent);
      agentActivityBus.emit('activity', {
        phase: 'end',
        tool: 'transcribe',
        callId: '42',
      } satisfies AgentActivityEvent);
      await new Promise((r) => setTimeout(r, 120));

      const acts = got.filter((m) => m.type === 'agentActivity');
      expect(acts).toEqual([
        { type: 'agentActivity', phase: 'start', tool: 'transcribe', callId: '42' },
        { type: 'agentActivity', phase: 'end', tool: 'transcribe', callId: '42' },
      ]);
      ws.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(wsDir, { recursive: true, force: true });
    }
    // startServer 開機要跑 loadFontTable（真的 spawn python3 逐一 probe 字型），
    // 在這台機器上就吃掉數十秒——30s 不夠，實測會逾時。
  }, 120_000);
});
