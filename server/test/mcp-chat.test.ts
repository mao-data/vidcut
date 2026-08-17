import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ChatMessage } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { tmpDir } from './tmp.js';

/**
 * MCP 的聊天渠道（`post_chat` / `get_chat`）——AI 這一側的門。
 *
 * 這是 CLAUDE.md 鐵則第三步的產物，但**不是**一個編輯操作：它不進 `Command`、
 * 不走 `applyCommand`、不動 doc。所以 `mcp-docs-sync.test.ts` 的 Command variant
 * 檢查不會涵蓋它，涵蓋它的是「每個工具都要出現在 instructions 裡」那一條。
 */

let store: ProjectStore;
let chat: ChatStore;
let client: Client;

beforeEach(async () => {
  const dir = await tmpDir('vidcut-mcpchat-');
  store = await ProjectStore.load(join(dir, 'project.json'));
  chat = await ChatStore.load(join(dir, 'chat.json'));
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews: new ReviewManager(store, 900_000),
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
    chat,
  };
  const server = createMcpServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
}, 60_000);

// 清理刻意**不做**：ChatStore 的落盤是 debounce 500ms 的射後不理，afterAll 立刻刪
// 目錄會撞 `ENOENT: open '.chat.json.tmp'`（ProjectStore 也有同樣的性質，這正是
// `global-setup.ts` 統一在整輪測試結束後才清的原因）。實測踩過一次。

function structured(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe('post_chat', () => {
  it('stores a message authored by the AI', async () => {
    const r = await client.callTool({ name: 'post_chat', arguments: { text: 'trimmed clip 3' } });
    expect(structured(r).ok).toBe(true);
    expect(chat.messages()).toHaveLength(1);
    expect(chat.messages()[0]).toMatchObject({ author: 'ai', text: 'trimmed clip 3' });
  });

  it('returns the stored message so the AI can see its own id and timestamp', async () => {
    const r = await client.callTool({ name: 'post_chat', arguments: { text: 'hello' } });
    const msg = structured(r).message as ChatMessage;
    expect(msg.author).toBe('ai');
    expect(msg.text).toBe('hello');
    expect(msg.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(msg.ts))).toBe(false);
  });

  it('rejects an empty message rather than posting a blank line', async () => {
    const r = await client.callTool({ name: 'post_chat', arguments: { text: '   ' } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(chat.messages()).toHaveLength(0);
  });

  it('does not touch the project (chat is not an edit: no version, no history, no undo)', async () => {
    const before = store.version;
    const historyBefore = store.history().length;
    await client.callTool({ name: 'post_chat', arguments: { text: 'just talking' } });
    expect(store.version).toBe(before);
    expect(store.history()).toHaveLength(historyBefore);
  });

  it('trims the message', async () => {
    await client.callTool({ name: 'post_chat', arguments: { text: '  padded  ' } });
    expect(chat.messages()[0]!.text).toBe('padded');
  });
});

describe('get_chat', () => {
  it('returns an empty list for a fresh project', async () => {
    const r = await client.callTool({ name: 'get_chat', arguments: {} });
    expect(structured(r).messages).toEqual([]);
  });

  it('returns messages from both sides in order', async () => {
    chat.append('user', 'make it shorter');
    await client.callTool({ name: 'post_chat', arguments: { text: 'done' } });
    chat.append('user', 'thanks');

    const r = await client.callTool({ name: 'get_chat', arguments: {} });
    const messages = structured(r).messages as ChatMessage[];
    expect(messages.map((m) => m.text)).toEqual(['make it shorter', 'done', 'thanks']);
    expect(messages.map((m) => m.author)).toEqual(['user', 'ai', 'user']);
  });

  it('limit returns only the most recent messages (the tail is what matters in a conversation)', async () => {
    for (let i = 0; i < 10; i++) chat.append('user', `m${i}`);
    const r = await client.callTool({ name: 'get_chat', arguments: { limit: 3 } });
    const messages = structured(r).messages as ChatMessage[];
    expect(messages.map((m) => m.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('limit 0 returns no messages (not "everything")', async () => {
    // `slice(-0)` 是整個陣列——get_history 踩過這個坑，這裡先釘住。
    for (let i = 0; i < 5; i++) chat.append('user', `m${i}`);
    const r = await client.callTool({ name: 'get_chat', arguments: { limit: 0 } });
    expect(structured(r).messages).toEqual([]);
  });

  it('is read-only: reading the chat does not add to it', async () => {
    chat.append('user', 'one');
    await client.callTool({ name: 'get_chat', arguments: {} });
    await client.callTool({ name: 'get_chat', arguments: {} });
    expect(chat.messages()).toHaveLength(1);
  });

  it('sees a message the user just sent (this is the point of the channel)', async () => {
    chat.append('user', 'can you shorten the intro?');
    const r = await client.callTool({ name: 'get_chat', arguments: {} });
    const messages = structured(r).messages as ChatMessage[];
    expect(messages.at(-1)).toMatchObject({ author: 'user', text: 'can you shorten the intro?' });
  });
});

describe('chat tools on the MCP surface', () => {
  it('both tools are registered', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('post_chat');
    expect(names).toContain('get_chat');
  });

  it('get_chat is annotated read-only', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'get_chat');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('post_chat is not annotated read-only (it appends to the log)', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'post_chat');
    expect(tool?.annotations?.readOnlyHint).not.toBe(true);
  });

  it('instructions explain that chat is a talk channel, not an editing path', async () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('post_chat');
    expect(instructions).toContain('get_chat');
    // 鐵則的重點：描述必須說清楚「editing 仍走既有工具」，否則 AI 會以為
    // 可以用聊天下編輯指令。
    expect(instructions).toMatch(/not an editing/i);
  });

  it('both tools declare an outputSchema (批 G 的規則)', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['post_chat', 'get_chat']) {
      expect(tools.find((t) => t.name === name)?.outputSchema, name).toBeDefined();
    }
  });
});
