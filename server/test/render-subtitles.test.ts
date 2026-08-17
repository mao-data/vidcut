import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRenderArgs, render, type CaptionCard } from '../src/render.js';
import { ProjectStore } from '../src/store.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer } from '../src/mcp.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { makeVideo } from './fixtures.js';
import { createEmptyProject, type CaptionItem, type Project } from '@vidcut/shared';
import { tmpDir } from './tmp.js';

const exec = promisify(execFile);

function projectWithCaption(): Project {
  const p = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 4, volume: 1 }];
  p.tracks.captions = [caption()];
  return p;
}

function caption(): CaptionItem {
  return {
    id: 'cap1',
    text: 'hi',
    start: 1,
    duration: 2,
    style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.78 },
  };
}

function cards(p: Project): CaptionCard[] {
  return [{ cap: p.tracks.captions[0]!, relPath: 'derived/captions/cap1.png', start: 1, end: 3 }];
}

function filtergraph(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1]!;
}

/** 一支 2 秒的真影片 + 一條中文字幕，寫成可被 ProjectStore.load 讀的專案。 */
async function makeRenderableProject(): Promise<{ dir: string; store: ProjectStore }> {
  const dir = await tmpDir('vidcut-subs-');
  await makeVideo(dir, 'a.mp4', { duration: 2 });
  const p = createEmptyProject('p', 'subs');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 2, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 2, volume: 1 }];
  p.tracks.captions = [{ ...caption(), start: 0.5, duration: 1, text: '你好世界' }];
  await writeFile(join(dir, 'project.json'), JSON.stringify({ ...p, rev: 0 }), 'utf8');
  return { dir, store: await ProjectStore.load(join(dir, 'project.json')) };
}

/** 成品裡的字幕串流 codec 名（沒有字幕軌時回空陣列）。 */
async function subtitleCodecs(file: string): Promise<string[]> {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    's',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout.split('\n').filter(Boolean);
}

describe('buildRenderArgs — subtitles mode', () => {
  it('burns captions by default, exactly as before the mode existed', () => {
    const p = projectWithCaption();
    const plan = buildRenderArgs(p, '/x', '/x/o.mp4', {
      captionCards: cards(p),
    });
    expect(plan.captionsBurned).toBe(true);
    expect(filtergraph(plan.args)).toContain('overlay=x=0:y=(H*0.78)');
  });

  for (const mode of ['off', 'sidecar', 'embed'] as const) {
    it(`does not composite caption cards in '${mode}' mode`, () => {
      const p = projectWithCaption();
      const plan = buildRenderArgs(p, '/x', '/x/o.mp4', {
        captionCards: cards(p),
        export: { subtitles: mode },
      });
      expect(plan.captionsBurned).toBe(false);
      expect(filtergraph(plan.args)).not.toContain('overlay=x=0:y=(H*0.78)');
    });

    it(`does not burn captions via drawtext in '${mode}' mode`, () => {
      const p = projectWithCaption();
      const plan = buildRenderArgs(p, '/x', '/x/o.mp4', {
        export: { subtitles: mode },
      });
      expect(plan.captionsBurned).toBe(false);
      expect(filtergraph(plan.args)).not.toContain('drawtext');
    });

    it(`drops the caption card inputs in '${mode}' mode so later input indices stay correct`, () => {
      const p = projectWithCaption();
      p.tracks.audio = [
        { id: 'a1', mediaId: 'm1', start: 0, in: 0, duration: 2, volume: 1, ducking: false },
      ];
      const plan = buildRenderArgs(p, '/x', '/x/o.mp4', {
        captionCards: cards(p),
        export: { subtitles: mode },
      });
      // 1 clip input + 1 audio input — 字卡那個 -i 不該存在
      expect(plan.args.filter((a) => a === '-i')).toHaveLength(2);
      // 音訊 input 索引必須是 1（緊接 clip），不是被字卡推開的 2
      expect(filtergraph(plan.args)).toContain('[1:a]');
    });
  }
});

describe('render — subtitle sidecar / soft track (integration)', () => {
  it("writes output/<stamp>.srt and leaves the mp4 subtitle-free in 'sidecar' mode", async () => {
    const { dir, store } = await makeRenderableProject();
    const res = await render(store, dir, 'sc', { subtitles: 'sidecar' });

    expect(res.captionsBurned).toBe(false);
    expect(res.subtitlePath).toBe(join('output', 'sc.srt'));
    const srt = await readFile(join(dir, res.subtitlePath!), 'utf8');
    expect(srt).toBe('1\n00:00:00,500 --> 00:00:01,500\n你好世界\n');
    expect(await subtitleCodecs(join(dir, res.outPath))).toEqual([]);
  }, 120_000);

  it("muxes a mov_text soft track that still decodes back to the original text in 'embed' mode", async () => {
    const { dir, store } = await makeRenderableProject();
    const res = await render(store, dir, 'em', { subtitles: 'embed' });

    expect(res.captionsBurned).toBe(false);
    expect(res.subtitlesEmbedded).toBe(true);
    expect(await subtitleCodecs(join(dir, res.outPath))).toEqual(['mov_text']);
    // 真的解回來——只驗 ffprobe 看得到軌，證不了 UTF-8 有活著
    const { stdout } = await exec('ffmpeg', [
      '-v',
      'error',
      '-i',
      join(dir, res.outPath),
      '-map',
      '0:s:0',
      '-f',
      'srt',
      '-',
    ]);
    expect(stdout).toContain('你好世界');
  }, 120_000);

  it('exposes the mode through the MCP render tool and reports the sidecar path back', async () => {
    const { dir, store } = await makeRenderableProject();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      store,
      projectDir: dir,
      editorContext: new EditorContext(),
      reviews: new ReviewManager(store, 900_000),
      baseUrl: 'http://127.0.0.1:3845',
      textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
      chat: await ChatStore.load(join(dir, 'chat.json')),
    });
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const schema = tools.tools.find((t) => t.name === 'render')!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toContain('subtitles');

    const res = (await client.callTool({
      name: 'render',
      arguments: { stamp: 'mcp', subtitles: 'sidecar' },
    })) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.subtitlePath).toBe(join('output', 'mcp.srt'));
    expect(res.structuredContent?.captionsBurned).toBe(false);

    await client.close();
    await server.close();
  }, 120_000);

  it("produces neither a sidecar nor a soft track in 'off' mode", async () => {
    const { dir, store } = await makeRenderableProject();
    const res = await render(store, dir, 'of', { subtitles: 'off' });

    expect(res.captionsBurned).toBe(false);
    expect(res.subtitlePath).toBeUndefined();
    expect(res.subtitlesEmbedded).toBe(false);
    expect(await subtitleCodecs(join(dir, res.outPath))).toEqual([]);
  }, 120_000);

  // MCP 工具描述明寫「字幕軌是空的時候 sidecar/embed 不會產生任何字幕檔或字幕軌」——
  // 釘住那句承諾，別讓成品多出一條空的 mov_text 軌或一個 0 byte 的 .srt。
  it('writes no subtitle artefacts at all when the caption track is empty', async () => {
    const { dir, store } = await makeRenderableProject();
    store.mutate('ai', 'clear captions', (d) => {
      d.tracks.captions = [];
    });
    const res = await render(store, dir, 'empty', { subtitles: 'embed' });

    expect(res.subtitlePath).toBeUndefined();
    expect(res.subtitlesEmbedded).toBe(false);
    expect(await subtitleCodecs(join(dir, res.outPath))).toEqual([]);
  }, 120_000);
});
