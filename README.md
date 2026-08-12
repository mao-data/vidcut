<div align="center">

# vidcut

**The AI-native video editor — your AI cuts through MCP, you supervise in the browser.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![MCP](https://img.shields.io/badge/MCP-native-8b5cf6.svg)](#connect-your-ai)

[繁體中文](README.zh-TW.md)

<img src="docs/assets/hero.png" alt="vidcut UI — timeline, live preview, captions panel" width="900" />

</div>

## What is vidcut?

vidcut is a **local-first timeline editor for vertical short video (1080×1920)** built around one idea: the AI and the human edit **the same timeline, at the same time**.

It is _not_ a prompt-to-video generator. An AI agent (Claude Code, or any MCP client) edits the project through [31 MCP tools](#mcp-tools) — importing footage, cutting, captioning, mixing audio, rendering. Every change appears **live in your browser** over WebSocket. You drag a caption, trim a clip, leave a review note — and the AI reads your adjustments back and keeps working. A human-in-the-loop editing loop, not a black box.

- 🖥️ **Local & private** — a single Node process on `127.0.0.1:3845`. Your footage never leaves your machine.
- 🤝 **Built for supervision** — the AI can call `request_review`; you annotate in the browser; it reads your feedback and continues.
- 🔍 **WYSIWYG captions & overlays** — preview and export render from the _same_ rasterized text card (byte-identical PNGs), guarded by a pixel-level regression suite.
- 🎬 **Real render pipeline** — ffmpeg composes the final 1080×1920 video from `project.json`, with progress reporting.

## How it works

```
┌──────────────┐   MCP  /mcp    ┌───────────────────────────┐   WebSocket  /ws   ┌───────────────┐
│ Claude Code  │ ─────────────▶ │   vidcut server  :3845    │ ◀────────────────▶ │  Browser UI   │
│ (or any MCP  │                │  ProjectStore · commands  │                    │  timeline ·   │
│  client)     │ ◀───────────── │  ffmpeg · whisper · cards │                    │  A/B preview ·│
└──────────────┘  review loop   └────────────┬──────────────┘                    │  inspector    │
                                             │                                   └───────────────┘
                                        project.json
                                     (single source of truth)
```

One process, one port, four kinds of traffic: static UI, `/media` (native Range for `<video>`), `/mcp`, and `/ws`. Every state change — from the AI or from you — goes through the same serialized command path and is broadcast to the browser as immer patches.

## Features

- ✂️ **Timeline editing** — split / delete-left / delete-right / freeze-frame at the playhead, trim by dragging, reorder, magnetic track, cursor-anchored zoom, snapping with guide lines, undo/redo
- 📺 **Seamless preview** — A/B dual-`<video>` player for gapless playback across cuts
- 🗣️ **Auto captions** — whisper.cpp transcription with word-level timestamps, automatic sentence segmentation, one call from audio to styled captions (`auto_caption`)
- 🎤 **Karaoke highlight** — per-word color reveal, rendered deterministically (one card per word) so export geometry is exact
- 📝 **WYSIWYG text cards** — captions and text overlays are rasterized by one Pillow pipeline shared by preview and export; CJK-aware auto-wrapping (per-character CJK, word-boundary Latin, forbidden-punctuation rules)
- 🖼️ **Overlays** — text or image, drag directly on the canvas with center/safe-margin snap guides
- 🔊 **Audio** — extract audio from clips, voiceover/BGM tracks, volume & fades, auto-ducking under speech
- 🌫️ **Blur fill** — landscape footage in a 9:16 canvas gets a blurred background instead of black bars
- 📤 **Export options** — 720p/1080p/4K, quality (CRF), 24/30/60 fps, H.264/HEVC; subtitles as **burn** / **embed** / **sidecar (.srt)** / **off**
- 🖼️ **Cover frame** — pick any moment as the cover, extracted from the rendered output when available
- 🔁 **Review loop** — `request_review` pauses writes, you approve or annotate in the UI, the AI reads `get_feedback` and continues

## Quick start

**1. Install prerequisites** — Node.js 20+, ffmpeg (with ffprobe), Python 3 + Pillow. whisper.cpp is optional (auto captions only). (The server itself runs on Node ≥18; the UI build in step 2 needs Vite's floor, **20.19+ or 22.12+**.)

macOS:

```bash
brew install ffmpeg
pip3 install pillow
brew install whisper-cpp   # optional
```

Debian / Ubuntu:

```bash
sudo apt install ffmpeg python3-pil fonts-noto-cjk   # fonts-noto-cjk: CJK text cards
# whisper.cpp (optional): build from https://github.com/ggerganov/whisper.cpp
```

Windows is untested — the text-card rasterizer spawns `python3` directly, so run vidcut under WSL.

**2. Run it**

```bash
git clone https://github.com/mao-data/vidcut.git
cd vidcut
npm install
npm run build -w @vidcut/ui   # builds ui/dist, which the server serves — skip this and :3845 404s
npm run demo                   # scaffolds the demo project and starts the server
```

Open **http://127.0.0.1:3845**. **No footage needed to try it** — `npm run demo` synthesizes five vertical clips with ffmpeg (one deliberately silent), a title overlay, and two captions.

> **Your own footage goes in through the AI, not the UI.** There is no import button yet (a Media panel is on the [roadmap](docs/ROADMAP.md)) — you point your agent at a folder and it calls `import_media`, which references files in place without copying them. So set up the MCP connection below before you bring your own clips.

> ⚠️ `npm run demo` _regenerates_ `projects/demo` every time. To serve an existing project without touching it:
>
> ```bash
> npx tsx server/src/index.ts projects/demo
> ```

**3. Auto captions (optional)**

`auto_caption` needs a whisper.cpp model on disk. vidcut looks in `~/.cache/whisper.cpp/`, then the Homebrew `share/whisper.cpp/models` dirs, and picks the most accurate model it finds:

```bash
mkdir -p ~/.cache/whisper.cpp
curl -L -o ~/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

That file is ~547 MB. Smaller models (`medium`, `small`, `base`, `tiny`) work too — same URL pattern, lower accuracy. Or point `VIDCUT_WHISPER_MODEL` at any `.bin`.

**Why Pillow is not optional:** it rasterizes every text card. Without it captions still write fine (the preview falls back to a rough DOM approximation), but `render` with `subtitles=burn` fails outright once the project has captions, and adding or editing a _text_ overlay (image overlays are unaffected) is rejected outright.

### Troubleshooting

| Symptom                                               | Cause & fix                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:3845` shows 404 / a blank page                      | `ui/dist` was never built. Run `npm run build -w @vidcut/ui`.                                                                                                       |
| `✗ 127.0.0.1:3845 is already in use` on start         | Another vidcut is running. Stop it, or start on another port — then open **that** port in the browser: `VIDCUT_PORT=3846 npx tsx server/src/index.ts projects/demo` |
| `whisper.cpp is not installed, or no model was found` | See step 3, or point `VIDCUT_WHISPER_MODEL` at a `.bin`.                                                                                                            |
| Captions render as boxes/blanks, or CJK missing       | No usable font. The server prints the candidate list at startup; on Linux install `fonts-noto-cjk`.                                                                 |
| `text card generation failed`                         | Pillow missing or `python3` not on `PATH`. See the Pillow note above.                                                                                               |

## Connect your AI

vidcut speaks [Model Context Protocol](https://modelcontextprotocol.io) over HTTP. With the server running:

**Claude Code**

```bash
claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
```

or in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "vidcut": {
      "type": "http",
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}
```

Then just talk to your agent:

> “Import the clips in `~/footage/cats`, keep the best 20 seconds, auto-caption it with karaoke highlight, duck the BGM under my voiceover, and send it to me for review before rendering.”

Any other MCP client works the same way — point it at `http://127.0.0.1:3845/mcp`.

## MCP tools

31 tools, grouped by what they touch:

| Group                 | Tools                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Read & context**    | `get_project` · `get_history` · `get_feedback` · `get_editor_context` (user's selection & playhead) · `get_frame` (see the canvas at time t) · `list_source` |
| **Media**             | `import_media` (absolute paths welcome — zero-copy)                                                                                                          |
| **Timeline**          | `set_timeline` · `add_clip` · `update_clip` · `reorder_clips` · `remove_clip` · `timeline_op` (split / deleteBefore / deleteAfter / freeze)                  |
| **Captions**          | `transcribe` (word timestamps) · `auto_caption` (one-shot ASR → captions) · `set_captions` · `update_caption`                                                |
| **Overlays**          | `add_overlay` · `update_overlay` · `remove_overlay` · `set_overlays`                                                                                         |
| **Audio**             | `extract_audio` · `set_audio` · `update_audio` · `remove_audio`                                                                                              |
| **Canvas & output**   | `set_canvas_fit` (letterbox / blur) · `set_cover` · `render`                                                                                                 |
| **History**           | `undo` · `redo`                                                                                                                                              |
| **Human in the loop** | `request_review`                                                                                                                                             |

Tool descriptions in the server are the authoritative, always-current reference — MCP clients see them automatically.

## Development

```
shared/   @vidcut/shared   types + pure functions (used by both sides)
server/   @vidcut/server   ProjectStore, commands, ffmpeg, whisper, MCP, WS, render
ui/       @vidcut/ui       React + Vite: timeline, A/B player, inspector, panels
```

| Command                                 | What it does                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm test`                              | full suite — real ffmpeg, real whisper (no mocks)                                                                |
| `npm run typecheck`                     | `tsc --noEmit` across all three workspaces                                                                       |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                                                                |
| `npm run dev:ui`                        | Vite dev server with HMR (proxies to :3845)                                                                      |
| `npm run verify:panels`                 | real-browser regression: panel controls                                                                          |
| `npm run verify:canvas`                 | real-browser regression: canvas zoom / drag / snap guides                                                        |
| `npm run verify:wysiwyg`                | renders a real video, screenshots the preview, compares ink bounding boxes — the proof behind "preview = export" |

Note: the server serves `ui/dist` (the build output). After changing UI source, run `npm run build -w @vidcut/ui` — only the `dev:ui` path skips this.

`npm install` currently reports advisories in transitive dependencies (`npm audit` for details; `--omit=dev` narrows it to what actually ships at runtime). They are known, not ignored — `bash scripts/gauntlet.sh` prints the audit on every full run.

## Known limitations

Honesty over marketing:

- **Karaoke preview ≠ export, slightly.** Exported karaoke captions are correct (one card per word, single layer). The _preview_ composites two cards with a clip-path, which makes text strokes look marginally thicker (~1% of pixels differ; invisible in practice). Non-karaoke captions and all overlays are byte-identical between preview and export.
- **Very short audio (≲4 s)** gets unreliable word timestamps from whisper.cpp; vidcut normalizes them, but expect less precision.
- **Single project, single user, localhost** — by design, for now.

## Roadmap

Next up (see [`docs/ROADMAP.md`](docs/ROADMAP.md)): detection tools for AI decision-making (`detect_silence` / `detect_scenes` / `detect_beats`), templates + batch rendering, and transcript-driven long-to-short editing.

## Contributing & docs

- [`CLAUDE.md`](CLAUDE.md) — agent-facing project rules (also a good map of the codebase's sharp edges)
- [`HANDOFF.md`](HANDOFF.md) — current state, how everything is verified, known trade-offs
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design decisions; [`docs/superpowers/plans/`](docs/superpowers/plans/) — implementation plans

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (contributions require a lightweight CLA).

## License

[AGPL-3.0-only](LICENSE). You can use, modify, and self-host vidcut freely; if you offer a modified version as a network service, the AGPL requires you to share your modifications' source with its users.
