import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ChatMessage, WsServerMsg } from '@vidcut/shared';
import { startServer } from '../src/index.js';
import { tmpDir } from './tmp.js';

/**
 * WS 的聊天渠道。**與 `command` 分開的路徑**：聊天不是 `Command`，不走
 * `applyCommand`，所以它不會產生 patch、不進版本/歷史/undo。
 * 驗證（空白、長度上限）寫在這一層（wsHub），不寫在 UI。
 */

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function open(dir: string) {
  const started = await startServer(dir, 0);
  const addr = started.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  close = () => new Promise((r) => started.server.close(() => r()));
  return { ...started, port };
}

/**
 * 一條**帶緩衝**的連線。
 *
 * ⚠️ 為什麼不能用「臨時掛 listener 等下一則」那種寫法（本檔原本就是那樣，實測會
 * 間歇性紅、每次紅在不同的 case 上）：server 在 `connection` 事件裡**連續**送
 * `full` 與初始的 `chat`，兩者可能落在同一個 tick。測試 `await` 掉 `full` 之後才去
 * 掛 chat 的 listener，那一則 `chat` 早就發生過了——`ws.on('message')` 不會補送，
 * 於是後面那個 `waitFor('chat')` 等的是一則永遠不會再來的訊息，直到逾時。
 *
 * 解法是從**建立連線的那一刻**就開始收，全部堆進陣列；`waitFor` 先掃緩衝、
 * 沒有才等新的。這樣「訊息比 listener 早到」就不再是一種失敗模式。
 */
class Conn {
  readonly ws: WebSocket;
  readonly seen: WsServerMsg[] = [];
  #waiters: (() => void)[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      this.seen.push(JSON.parse(d.toString()) as WsServerMsg);
      const waiters = this.#waiters;
      this.#waiters = [];
      for (const w of waiters) w();
    });
  }

  /** 等到「第 n 則以後」出現指定型別的訊息；預設從頭找。 */
  async waitFor<T extends WsServerMsg['type']>(
    type: T,
    from = 0,
    timeoutMs = 5000,
  ): Promise<Extract<WsServerMsg, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.seen.slice(from).find((m) => m.type === type);
      if (hit) return hit as Extract<WsServerMsg, { type: T }>;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** 已收到幾則（給 `waitFor` 當「從這裡之後」的游標）。 */
  get count(): number {
    return this.seen.length;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(port: number): Promise<Conn> {
  const conn = new Conn(port);
  await conn.waitFor('full'); // 連上並收到初始狀態
  return conn;
}

describe('ws chat channel', () => {
  it('sendChatMessage stores the message and broadcasts it to the sender', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);

    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: 'make clip 3 shorter' });
    const chat = await ws.waitFor('chat', from);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ author: 'user', text: 'make clip 3 shorter' });
    ws.close();
  });

  it('broadcasts to every connected client, not just the sender', async () => {
    // 這是這個功能的重點：AI 那邊（MCP）與其他分頁都要看得到人剛說了什麼。
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const a = await connect(port);
    const b = await connect(port);

    const from = b.count;
    a.send({ type: 'sendChatMessage', text: 'hello from a' });
    const chat = await b.waitFor('chat', from);
    expect(chat.messages.map((m: ChatMessage) => m.text)).toEqual(['hello from a']);
    a.close();
    b.close();
  });

  it('sends the existing chat log to a client on connect', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const a = await connect(port);
    const from = a.count;
    a.send({ type: 'sendChatMessage', text: 'earlier message' });
    await a.waitFor('chat', from);
    a.close();

    // 全新的連線（＝重整分頁）必須看得到之前的對話。
    const b = await connect(port);
    const chat = await b.waitFor('chat');
    expect(chat.messages.map((m) => m.text)).toEqual(['earlier message']);
    b.close();
  });

  it('does not touch the project: no patch, no version bump, no history', async () => {
    // 聊天不是編輯。版本一動，UI 的活動流就會多一筆「你做了什麼」——那是假的。
    const dir = await tmpDir('vidcut-wschat-');
    const { port, store } = await open(dir);
    const before = store.version;
    const historyBefore = store.history().length;
    const ws = await connect(port);

    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: 'just talking' });
    await ws.waitFor('chat', from);

    expect(store.version).toBe(before);
    expect(store.history()).toHaveLength(historyBefore);
    // 廣播裡也不該混進 patch（那代表有人把聊天寫進了 doc）。
    expect(ws.seen.some((m) => m.type === 'patch')).toBe(false);
    ws.close();
  });

  it('persists to chat.json next to project.json', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);
    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: 'written to disk' });
    await ws.waitFor('chat', from);
    ws.close();

    // 落盤是 debounce 的——輪詢到檔案出現為止，而不是睡一個猜的秒數。
    const path = join(dir, 'chat.json');
    let raw: string | null = null;
    for (let i = 0; i < 60 && raw === null; i++) {
      raw = await readFile(path, 'utf8').catch(() => null);
      if (raw === null) await new Promise((r) => setTimeout(r, 50));
    }
    expect(raw).not.toBeNull();
    const file = JSON.parse(raw!) as { messages: ChatMessage[] };
    expect(file.messages.map((m) => m.text)).toEqual(['written to disk']);
  });

  it('rejects an empty or whitespace-only message (validation lives in the command layer)', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);

    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: '   ' });
    ws.send({ type: 'sendChatMessage', text: '' });
    // 空白訊息被擋掉之後，一則合法訊息應該是清單裡的唯一一筆。
    ws.send({ type: 'sendChatMessage', text: 'real one' });
    const chat = await ws.waitFor('chat', from);
    expect(chat.messages.map((m) => m.text)).toEqual(['real one']);
    ws.close();
  });

  it('trims surrounding whitespace off a stored message', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);
    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: '  padded  ' });
    const chat = await ws.waitFor('chat', from);
    expect(chat.messages[0]!.text).toBe('padded');
    ws.close();
  });

  it('ignores a non-string text field instead of storing garbage', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);

    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: 42 });
    ws.send({ type: 'sendChatMessage' });
    ws.send({ type: 'sendChatMessage', text: 'valid' });
    const chat = await ws.waitFor('chat', from);
    expect(chat.messages.map((m) => m.text)).toEqual(['valid']);
    ws.close();
  });

  it('caps an over-long message rather than storing it unbounded', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);
    const from = ws.count;
    ws.send({ type: 'sendChatMessage', text: 'x'.repeat(50_000) });
    const chat = await ws.waitFor('chat', from);
    expect(chat.messages[0]!.text.length).toBeLessThanOrEqual(4000);
    expect(chat.messages[0]!.text.length).toBeGreaterThan(0);
    ws.close();
  });

  it('keeps messages in order when several arrive back to back', async () => {
    const dir = await tmpDir('vidcut-wschat-');
    const { port } = await open(dir);
    const ws = await connect(port);

    for (const t of ['one', 'two', 'three', 'four']) {
      const from = ws.count;
      ws.send({ type: 'sendChatMessage', text: t });
      await ws.waitFor('chat', from);
    }
    const last = ws.seen.filter((m) => m.type === 'chat').at(-1)!;
    expect(last.messages.map((m) => m.text)).toEqual(['one', 'two', 'three', 'four']);
    ws.close();
  });
});
