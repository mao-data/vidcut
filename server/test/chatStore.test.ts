import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatStore } from '../src/chatStore.js';
import { tmpDir } from './tmp.js';

/**
 * ChatStore：每專案一份 `chat.json`（與 `project.json` 同目錄）。
 *
 * **刻意不是 ProjectStore 的一部分**：聊天是關於編輯的 meta 溝通，不是編輯本身。
 * 它不進 doc、不進版本/歷史/undo——按 Cmd+Z 不該把一句話撤掉。
 */
describe('ChatStore', () => {
  it('starts empty when chat.json does not exist', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    expect(store.messages()).toEqual([]);
  });

  it('appends a message with id / author / text / ts', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    const msg = store.append('user', 'shorten clip 3');
    expect(msg.author).toBe('user');
    expect(msg.text).toBe('shorten clip 3');
    expect(msg.id).toBeTruthy();
    // ts 是 ISO 8601——UI 端直接 Date.parse，不做格式猜測
    expect(Number.isNaN(Date.parse(msg.ts))).toBe(false);
    expect(store.messages()).toEqual([msg]);
  });

  it('keeps insertion order across authors', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    store.append('user', 'one');
    store.append('ai', 'two');
    store.append('user', 'three');
    expect(store.messages().map((m) => m.text)).toEqual(['one', 'two', 'three']);
    expect(store.messages().map((m) => m.author)).toEqual(['user', 'ai', 'user']);
  });

  it('gives every message a distinct id (ids are the UI list keys)', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(store.append('ai', `m${i}`).id);
    expect(ids.size).toBe(50);
  });

  it('persists to disk and reloads', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const path = join(dir, 'chat.json');
    const a = await ChatStore.load(path);
    a.append('user', 'hello');
    a.append('ai', 'on it');
    await a.flush();

    const b = await ChatStore.load(path);
    expect(b.messages().map((m) => m.text)).toEqual(['hello', 'on it']);
    expect(b.messages().map((m) => m.author)).toEqual(['user', 'ai']);
  });

  it('writes chat.json as readable JSON (it sits next to project.json)', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const path = join(dir, 'chat.json');
    const store = await ChatStore.load(path);
    store.append('user', 'hi');
    await store.flush();
    const raw = JSON.parse(await readFile(path, 'utf8')) as { messages: unknown[] };
    expect(Array.isArray(raw.messages)).toBe(true);
    expect(raw.messages).toHaveLength(1);
  });

  it('tolerates broken JSON: loads as an empty list rather than throwing', async () => {
    // 壞掉的 chat.json 不該讓 server 起不來——聊天是附屬功能，
    // 而 `startServer` 裡任何一個 throw 都等於整個編輯器打不開。
    const dir = await tmpDir('vidcut-chat-');
    const path = join(dir, 'chat.json');
    await writeFile(path, '{ this is not json', 'utf8');
    const store = await ChatStore.load(path);
    expect(store.messages()).toEqual([]);
  });

  it('tolerates valid JSON of the wrong shape', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const path = join(dir, 'chat.json');
    await writeFile(path, '[1, 2, 3]', 'utf8');
    const store = await ChatStore.load(path);
    expect(store.messages()).toEqual([]);
  });

  it('drops entries that are not well-formed messages, keeping the good ones', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const path = join(dir, 'chat.json');
    await writeFile(
      path,
      JSON.stringify({
        messages: [
          { id: 'a', author: 'user', text: 'good', ts: '2026-08-17T00:00:00.000Z' },
          { id: 'b', author: 'martian', text: 'bad author', ts: '2026-08-17T00:00:01.000Z' },
          { id: 'c', author: 'ai', ts: '2026-08-17T00:00:02.000Z' },
          null,
          { id: 'd', author: 'ai', text: 'also good', ts: '2026-08-17T00:00:03.000Z' },
        ],
      }),
      'utf8',
    );
    const store = await ChatStore.load(path);
    expect(store.messages().map((m) => m.text)).toEqual(['good', 'also good']);
  });

  it('notifies listeners on append (this is what the WS broadcast hangs off)', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    const seen: string[][] = [];
    store.onChange((messages) => seen.push(messages.map((m) => m.text)));
    store.append('user', 'a');
    store.append('ai', 'b');
    expect(seen).toEqual([['a'], ['a', 'b']]);
  });

  it('unsubscribes listeners', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    let calls = 0;
    const off = store.onChange(() => calls++);
    store.append('user', 'a');
    off();
    store.append('user', 'b');
    expect(calls).toBe(1);
  });

  it('creates the directory when persisting into a path that does not exist yet', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const path = join(dir, 'nested', 'chat.json');
    const store = await ChatStore.load(path);
    store.append('user', 'hi');
    await store.flush();
    const reloaded = await ChatStore.load(path);
    expect(reloaded.messages()).toHaveLength(1);
  });

  it('messages() returns a snapshot that callers cannot use to mutate the store', async () => {
    const dir = await tmpDir('vidcut-chat-');
    const store = await ChatStore.load(join(dir, 'chat.json'));
    store.append('user', 'a');
    const snapshot = store.messages() as ReturnType<ChatStore['messages']>;
    (snapshot as unknown as unknown[]).push({ id: 'x', author: 'ai', text: 'nope', ts: 'now' });
    expect(store.messages()).toHaveLength(1);
  });

  it('reload picks up messages appended by another store instance', async () => {
    // 兩個 instance 指同一個檔案不是支援情境，但至少證明落盤格式是可互讀的。
    const dir = await tmpDir('vidcut-chat-');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'chat.json');
    const a = await ChatStore.load(path);
    a.append('ai', 'from a');
    await a.flush();
    const b = await ChatStore.load(path);
    b.append('user', 'from b');
    await b.flush();
    const c = await ChatStore.load(path);
    expect(c.messages().map((m) => m.text)).toEqual(['from a', 'from b']);
  });
});
