# 字幕 WYSIWYG + 文字 overlay + 預覽拖曳 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 預覽字幕/文字與渲染成品像素級一致(單一 Pillow 光柵器)、可編輯文字 overlay、預覽直接拖曳。

**Architecture:** 依 spec [2026-08-03-caption-wysiwyg-design.md](../specs/2026-08-03-caption-wysiwyg-design.md)(v2)。text_card.py 增常駐 worker 模式 → `rasterizer.ts` 包裝 → `textCards.ts` 內容雜湊快取與 HTTP 端點 → 預覽端 1080×1920 座標空間直接顯示同一張 PNG。渲染管線(render.ts 的 CLI 呼叫路徑)零改動。

**Tech Stack:** Node+TS(express/ws/vitest)、Python Pillow、React+zustand、CDP e2e。

## Global Constraints

- **不新增任何 npm/pip 依賴**(hash 用 `node:crypto`;worker 通訊用 stdin/stdout JSONL)。
- `fontSize` 單位維持「畫布 px」(1080×1920 座標系);位置維持 0–1 畫布分數。schema 只加欄位、不改既有欄位語意。
- 快取 key 必含 `rasterizerId`(現值 `'pillow-1'`),換光柵器全快取自動失效。
- **打字絕不走命令層**(spec §7):每鍵=本地 state;停手 80ms=預覽產卡通道(不進 history);失焦/Enter=命令。
- 吸附一律以**實際 bbox** 計算,不用 position 錨點(x=中心、y=上緣的不對稱)。
- zustand selector **禁止回傳新 reference**(fallback 用模組級常數;repo 已有 React #185 前科)。
- 改了工具行為或語意必須同步更新 `server/src/mcp.ts` 描述與 instructions(CLAUDE.md 鐵則)。
- UI 原始碼改完要 `npm run build -w @vidcut/ui` 才會反映到 :3845。
- **Commit 政策**:此 repo 規定未經使用者同意不 commit。執行第一個 task 完成時問使用者一次;獲同意後照各 task 的 commit 步驟執行,**只 stage 該 task 動過的路徑**(絕不 `git add -A`,工作區有其他 session)。未獲同意則跳過所有 commit 步驟,改在每階段結尾回報待 commit 清單。
- 各 task 的測試指令都在 `ai-video-cut/` 執行;server 測試跑真 ffmpeg/真 Python。

---

## 階段 1:光柵器地基(全 server,UI 不動)

### Task 1: text_card.py worker 模式 + 雙卡 + 逐詞 bbox + rasterizer.ts

**Files:**

- Modify: `server/scripts/text_card.py`(加 `--worker`;既有 CLI 單卡模式**行為不變**)
- Create: `server/src/rasterizer.ts`
- Test: `server/test/rasterizer.test.ts`

**Interfaces:**

- Produces(後續所有 task 依賴):
  ```ts
  export interface TextCardStyle {
    fontFamily: string;
    fontSize: number;
    fill: string;
    stroke?: string;
    highlight?: string;
  }
  export interface CardRequest {
    text: string;
    tokens?: string[];
    style: TextCardStyle;
    width: number;
    maxWidthFrac?: number;
  }
  export interface TokenBox {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  export interface CardGeometry {
    width: number;
    height: number;
    lines: number;
    tokens?: TokenBox[];
  }
  export class PillowRasterizer {
    readonly id = 'pillow-1';
    constructor(resolveFontPath: (family: string) => string | undefined);
    probeFont(path: string): Promise<boolean>;
    rasterize(req: CardRequest, outBase: string, outHl?: string): Promise<CardGeometry>;
    dispose(): void;
  }
  ```
- Worker 協議(stdin 一行 JSON → stdout 一行 JSON):
  請求 `{"text","tokens":[..]|null,"fontSize","fill","stroke"|null,"highlight"|null,"width","margin","fontPath"|null,"outBase","outHl"|null}`
  或 `{"op":"probeFont","path":"..."}`;回應 `{"ok":true,...幾何}` / `{"ok":false,"error":"..."}`。

- [ ] **Step 1: 寫失敗測試**

```ts
// server/test/rasterizer.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PillowRasterizer } from '../src/rasterizer.js';

const r = new PillowRasterizer(() => undefined); // 無字型表 → text_card 既有候選鏈
afterAll(() => r.dispose());

describe('PillowRasterizer', () => {
  it('renders base+highlight cards with identical geometry and per-token bboxes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const geo = await r.rasterize(
      {
        text: '這是測試字幕',
        tokens: ['這是', '測試', '字幕'],
        style: {
          fontFamily: 'PingFang TC',
          fontSize: 64,
          fill: '#ffffff',
          stroke: '#000000',
          highlight: '#FCDE5A',
        },
        width: 1080,
      },
      join(dir, 'a.base.png'),
      join(dir, 'a.hl.png'),
    );
    expect(geo.width).toBe(1080);
    expect(geo.height).toBeGreaterThan(60);
    expect(geo.tokens).toHaveLength(3);
    // bbox 單調遞增且在畫布內
    const t = geo.tokens!;
    expect(t[1]!.x).toBeGreaterThan(t[0]!.x);
    expect(t[2]!.x + t[2]!.w).toBeLessThanOrEqual(1080);
    // 兩張卡都存在且非空(幾何一致由同一次排版保證)
    expect((await stat(join(dir, 'a.base.png'))).size).toBeGreaterThan(0);
    expect((await stat(join(dir, 'a.hl.png'))).size).toBeGreaterThan(0);
    // 兩卡尺寸相同(PNG IHDR 寬高 bytes 16-24 相同)
    const [b, h] = await Promise.all([
      readFile(join(dir, 'a.base.png')),
      readFile(join(dir, 'a.hl.png')),
    ]);
    expect(b.subarray(16, 24)).toEqual(h.subarray(16, 24));
  }, 30_000);

  it('renders a plain card (no tokens) without hl output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const geo = await r.rasterize(
      { text: 'plain', style: { fontFamily: 'x', fontSize: 48, fill: '#fff' }, width: 1080 },
      join(dir, 'p.base.png'),
    );
    expect(geo.tokens).toBeUndefined();
    expect(geo.lines).toBe(1);
  }, 30_000);

  it('probeFont: 開得了的字型 true、開不了的 false', async () => {
    expect(await r.probeFont('/System/Library/Fonts/STHeiti Medium.ttc')).toBe(true);
    expect(await r.probeFont('/nonexistent.ttf')).toBe(false);
  }, 30_000);

  it('serializes concurrent requests through one worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const reqs = Array.from({ length: 5 }, (_, i) =>
      r.rasterize(
        { text: `並發${i}`, style: { fontFamily: 'x', fontSize: 40, fill: '#fff' }, width: 1080 },
        join(dir, `c${i}.base.png`),
      ),
    );
    const geos = await Promise.all(reqs);
    for (const g of geos) expect(g.width).toBe(1080);
  }, 30_000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/rasterizer.test.ts`
Expected: FAIL(`rasterizer.js` 不存在)

- [ ] **Step 3: 改 text_card.py**

把繪製抽成可重用函數並加 worker 迴圈;既有 `main()`(CLI 單卡)改為呼叫同一套函數,輸出格式不變:

```python
def load_font_by(path, size, cache):
    key = (path, size)
    if key not in cache:
        cache[key] = ImageFont.truetype(path, size) if path else load_font(size)
    return cache[key]


def render_cards(cfg, font_cache):
    """一次排版 → 畫 base(全 fill 色)與 hl(全 highlight 色)兩張,回幾何+逐詞 bbox。"""
    size = int(cfg.get("fontSize", 64))
    fill = cfg.get("fill", "#ffffff")
    stroke = cfg.get("stroke")
    highlight = cfg.get("highlight") or fill
    width = int(cfg.get("width", 1080))
    tokens = cfg.get("tokens") or None
    stroke_w = max(2, size // 16) if stroke else 0
    margin = int(cfg.get("margin", max(32, width // 20)))

    font = load_font_by(cfg.get("fontPath"), size, font_cache)
    tmp = Image.new("RGBA", (1, 1))
    measure = ImageDraw.Draw(tmp)
    line_h = size + max(6, size // 5)

    if tokens:
        lines = layout_tokens(measure, tokens, font, width - margin * 2)
    else:
        lines = [[(part, 0.0, -1)] for part in cfg["text"].split("\n")]

    height = line_h * len(lines) + stroke_w * 2 + 8
    y_start = stroke_w + 4

    boxes = []
    if tokens:
        for li, line in enumerate(lines):
            x0 = (width - line_width(measure, line, font)) / 2
            for tok, dx, idx in line:
                if idx >= 0:
                    boxes.append({
                        "x": round(x0 + dx, 1), "y": y_start + li * line_h,
                        "w": round(measure.textlength(tok, font=font), 1), "h": line_h,
                    })

    def paint(active, out_path):
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        y = y_start
        for line in lines:
            x0 = (width - line_width(draw, line, font)) / 2
            for tok, dx, idx in line:
                draw.text((x0 + dx, y), tok, font=font,
                          fill=highlight if (idx >= 0 and idx <= active) else fill,
                          stroke_width=stroke_w, stroke_fill=stroke if stroke else None)
            y += line_h
        img.save(out_path)

    paint(int(cfg.get("activeIndex", -1)), cfg["out"] if "out" in cfg else cfg["outBase"])
    if tokens and cfg.get("outHl"):
        paint(len(tokens) - 1, cfg["outHl"])
    return {"ok": True, "width": width, "height": height, "lines": len(lines),
            "tokens": boxes if tokens else None}


def worker_loop():
    font_cache = {}
    for raw in sys.stdin:
        try:
            req = json.loads(raw)
            if req.get("op") == "probeFont":
                try:
                    ImageFont.truetype(req["path"], 32)
                    print(json.dumps({"ok": True}), flush=True)
                except OSError as e:
                    print(json.dumps({"ok": False, "error": str(e)}), flush=True)
                continue
            print(json.dumps(render_cards(req, font_cache)), flush=True)
        except Exception as e:  # worker 絕不因單一請求死掉
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)


def main() -> None:
    if "--worker" in sys.argv:
        worker_loop()
        return
    cfg = json.load(sys.stdin)
    out = render_cards(cfg, {})
    print(json.dumps({"width": out["width"], "height": out["height"], "lines": out["lines"]}))
```

注意:CLI 模式吃 `"out"` 鍵(舊介面)、worker 模式吃 `"outBase"`/`"outHl"`——`render_cards` 兩者都接。刪掉 `main()` 裡原本的排版/繪製重複碼。

- [ ] **Step 4: 寫 rasterizer.ts**

```ts
// server/src/rasterizer.ts — Pillow 常駐 worker(7ms/張;逐次 spawn 要 50-70ms)
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_CARD_PY = join(dirname(fileURLToPath(import.meta.url)), '../scripts/text_card.py');

export interface TextCardStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  stroke?: string;
  highlight?: string;
}
export interface CardRequest {
  text: string;
  tokens?: string[];
  style: TextCardStyle;
  /** 畫布寬(1080) */
  width: number;
  /** 換行寬 0–1,預設 0.9(= text_card 既有 margin 預設) */
  maxWidthFrac?: number;
}
export interface TokenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CardGeometry {
  width: number;
  height: number;
  lines: number;
  tokens?: TokenBox[];
}
interface WorkerReply extends Partial<CardGeometry> {
  ok: boolean;
  error?: string;
  tokens?: TokenBox[] | null;
}

export class PillowRasterizer {
  readonly id = 'pillow-1';
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  // public 可變:啟動時字型表要靠 rasterizer 自己 probe,表建好後回頭換上真 resolver(Task 2)
  constructor(public resolveFontPath: (family: string) => string | undefined) {}

  private ensureChild(): void {
    if (this.child && this.child.exitCode === null) return;
    this.child = spawn('python3', [TEXT_CARD_PY, '--worker'], { stdio: 'pipe' });
    this.rl = createInterface({ input: this.child.stdout });
  }

  /** 單一 in-flight:請求排隊送 worker,一問一答。worker 掛了下個請求自動重啟。 */
  private request<T extends WorkerReply>(payload: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      this.ensureChild();
      const child = this.child!;
      const reply = new Promise<string>((res, rej) => {
        const onExit = () => rej(new Error('rasterizer worker died'));
        child.once('exit', onExit);
        this.rl!.once('line', (l) => {
          child.removeListener('exit', onExit);
          res(l);
        });
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
      return JSON.parse(await reply) as T;
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async probeFont(path: string): Promise<boolean> {
    return (await this.request({ op: 'probeFont', path })).ok;
  }

  async rasterize(req: CardRequest, outBase: string, outHl?: string): Promise<CardGeometry> {
    const margin = Math.round((req.width * (1 - (req.maxWidthFrac ?? 0.9))) / 2);
    const r = await this.request({
      text: req.text,
      tokens: req.tokens ?? null,
      fontSize: req.style.fontSize,
      fill: req.style.fill,
      stroke: req.style.stroke ?? null,
      highlight: req.style.highlight ?? null,
      width: req.width,
      margin,
      fontPath: this.resolveFontPath(req.style.fontFamily) ?? null,
      outBase,
      outHl: outHl ?? null,
    });
    if (!r.ok) throw new Error(`rasterize failed: ${r.error}`);
    return {
      width: r.width!,
      height: r.height!,
      lines: r.lines!,
      ...(r.tokens ? { tokens: r.tokens } : {}),
    };
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run server/test/rasterizer.test.ts`
Expected: 4 PASS

- [ ] **Step 6: 確認既有渲染路徑沒壞(CLI 模式回歸)**

Run: `npx vitest run server/test/render.test.ts server/test/captions-karaoke.test.ts server/test/render-t1.test.ts`
Expected: 全 PASS(render.ts 走的 CLI 單卡模式輸出格式未變)

- [ ] **Step 7: Commit**

```bash
git add server/scripts/text_card.py server/src/rasterizer.ts server/test/rasterizer.test.ts
git commit -m "feat(server): text_card worker 模式 + PillowRasterizer(雙卡/逐詞 bbox/常駐 7ms)"
```

---

### Task 2: 字型表(啟動實測可用性)+ /api/fonts + /fonts/:id

**Files:**

- Create: `server/src/fonts.ts`
- Modify: `server/src/app.ts`(加端點;`createApp` 增參數)
- Modify: `server/src/index.ts`(建 rasterizer + 字型表,傳入 createApp)
- Test: `server/test/fonts.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface FontEntry {
    id: string;
    family: string;
    path: string;
  }
  export async function loadFontTable(r: PillowRasterizer): Promise<FontEntry[]>; // 只留 Pillow 開得了的
  export function fontResolver(table: FontEntry[]): (family: string) => string | undefined;
  // family 完全比對 → 該檔;查無 → 表首位(絕不回 undefined,除非表空)
  ```
- `createApp(store, projectDir, uiDistDir?, extras?: { fonts?: FontEntry[]; textCards?: TextCardService })`(textCards 於 Task 3 加入)
- HTTP:`GET /api/fonts` → `[{id, family}]`;`GET /fonts/:id` → 字型檔(供 UI @font-face)

- [ ] **Step 1: 寫失敗測試**

```ts
// server/test/fonts.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { loadFontTable, fontResolver } from '../src/fonts.js';
import { PillowRasterizer } from '../src/rasterizer.js';

const r = new PillowRasterizer(() => undefined);
afterAll(() => r.dispose());

describe('font table', () => {
  it('probes candidates and keeps only loadable fonts', async () => {
    const table = await loadFontTable(r);
    expect(table.length).toBeGreaterThan(0);
    // 這台機器 PingFang.ttc 開不了(HANDOFF 記錄)——不得出現在表裡
    expect(table.some((f) => f.path.includes('PingFang'))).toBe(false);
    expect(table.some((f) => f.path.includes('STHeiti'))).toBe(true);
  }, 30_000);

  it('resolver: 完全比對命中,未知 family 落到表首位', async () => {
    const table = await loadFontTable(r);
    const resolve = fontResolver(table);
    expect(resolve(table[0]!.family)).toBe(table[0]!.path);
    expect(resolve('沒有這個字型')).toBe(table[0]!.path);
    expect(fontResolver([])('x')).toBeUndefined();
  }, 30_000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/fonts.test.ts`
Expected: FAIL(fonts.js 不存在)

- [ ] **Step 3: 寫 fonts.ts**

```ts
// server/src/fonts.ts — fontFamily → 字型檔對照。啟動時用 Pillow 實測,開不了的剔除
// (這台機器 PingFang.ttc 會 OSError,若照單全收 fontFamily 就是死欄位)。
import type { PillowRasterizer } from './rasterizer.js';

export interface FontEntry {
  id: string;
  family: string;
  path: string;
}

const CANDIDATES: FontEntry[] = [
  { id: 'heiti-tc', family: 'Heiti TC', path: '/System/Library/Fonts/STHeiti Medium.ttc' },
  { id: 'pingfang-tc', family: 'PingFang TC', path: '/System/Library/Fonts/PingFang.ttc' },
  {
    id: 'hiragino-gb',
    family: 'Hiragino Sans GB',
    path: '/System/Library/Fonts/Hiragino Sans GB.ttc',
  },
  {
    id: 'arial-unicode',
    family: 'Arial Unicode MS',
    path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  },
];

export async function loadFontTable(r: PillowRasterizer): Promise<FontEntry[]> {
  const table: FontEntry[] = [];
  for (const c of CANDIDATES) {
    if (await r.probeFont(c.path)) table.push(c);
    else console.warn(`⚠ 字型不可用(已剔除):${c.family} @ ${c.path}`);
  }
  return table;
}

export function fontResolver(table: FontEntry[]): (family: string) => string | undefined {
  return (family) => (table.find((f) => f.family === family) ?? table[0])?.path;
}
```

- [ ] **Step 4: app.ts 加端點**

在 `createApp` 簽名加 `extras?: { fonts?: FontEntry[] }`,`/media` 之前插入:

```ts
app.get('/api/fonts', (_req, res) => {
  res.json((extras?.fonts ?? []).map((f) => ({ id: f.id, family: f.family })));
});
app.get('/fonts/:id', (req, res) => {
  const f = extras?.fonts?.find((x) => x.id === req.params.id);
  if (!f) {
    res.status(404).end();
    return;
  }
  res.sendFile(f.path);
});
```

index.ts:`startServer` 內建 `const rasterizer = new PillowRasterizer(() => undefined);`(resolver 循環:先 `loadFontTable(rasterizer)` 再 `rasterizer` 換上真 resolver——直接改成先建表用的臨時 rasterizer 也行;最簡:`const raster = new PillowRasterizer(() => undefined); const fonts = await loadFontTable(raster); (raster as { resolveFontPath?: unknown }).resolveFontPath = fontResolver(fonts);` 不行——private。**正解**:`PillowRasterizer` 的 constructor 改吃 `() => resolver` 風格不必要;把 `resolveFontPath` 宣告為 `public` 可變欄位:`constructor(public resolveFontPath: (family: string) => string | undefined) {}`,啟動後 `raster.resolveFontPath = fontResolver(fonts);`)。傳 `createApp(store, projectDir, uiDist, { fonts })`。

- [ ] **Step 5: 跑測試 + 全 server 測試**

Run: `npx vitest run server/test/fonts.test.ts && npx vitest run server/test`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/fonts.ts server/src/app.ts server/src/index.ts server/src/rasterizer.ts server/test/fonts.test.ts
git commit -m "feat(server): 字型表啟動實測 + /api/fonts + /fonts/:id(fontFamily 起死回生前置)"
```

---

### Task 3: TextCardService(內容雜湊快取)+ /text-card 端點 + preview 通道

**Files:**

- Create: `server/src/textCards.ts`
- Modify: `server/src/app.ts`(`/text-card/*` static + `POST /text-card/preview`)
- Modify: `server/src/index.ts`(建 service 傳入 createApp)
- Test: `server/test/textCards.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export function cardKey(req: CardRequest, rasterizerId: string): string; // 16 hex chars
  export interface CardResult extends CardGeometry {
    hash: string;
  }
  export class TextCardService {
    constructor(projectDir: string, rasterizer: PillowRasterizer);
    ensure(req: CardRequest): Promise<CardResult>; // 快取命中不重畫
    relBasePath(hash: string): string; // 'derived/text/<hash>.base.png'
  }
  ```
- HTTP:`GET /text-card/<hash>.(base|hl).png|<hash>.json`(immutable 強快取);`POST /text-card/preview`(body=CardRequest 少 width 時用 doc.canvas.width)→ `CardResult`

- [ ] **Step 1: 寫失敗測試**

```ts
// server/test/textCards.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardKey, TextCardService } from '../src/textCards.js';
import { PillowRasterizer, type CardRequest } from '../src/rasterizer.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

const REQ: CardRequest = {
  text: '哈囉世界',
  tokens: ['哈囉', '世界'],
  style: {
    fontFamily: 'Heiti TC',
    fontSize: 64,
    fill: '#ffffff',
    stroke: '#000000',
    highlight: '#FCDE5A',
  },
  width: 1080,
};

describe('cardKey', () => {
  it('same input → same key; 與時間無關的欄位不影響 key', () => {
    expect(cardKey(REQ, 'pillow-1')).toBe(cardKey({ ...REQ }, 'pillow-1'));
  });
  it('改字必變;換 rasterizerId 必變', () => {
    expect(cardKey({ ...REQ, text: '改了' }, 'pillow-1')).not.toBe(cardKey(REQ, 'pillow-1'));
    expect(cardKey(REQ, 'chromium-1')).not.toBe(cardKey(REQ, 'pillow-1'));
  });
});

describe('TextCardService', () => {
  it('ensure 產卡落盤;第二次命中快取(檔案 mtime 不變)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    expect(a.tokens).toHaveLength(2);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    const m1 = (await stat(baseAbs)).mtimeMs;
    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash);
    expect((await stat(baseAbs)).mtimeMs).toBe(m1); // 沒重畫
  }, 30_000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/textCards.test.ts`
Expected: FAIL

- [ ] **Step 3: 寫 textCards.ts**

```ts
// server/src/textCards.ts — 內容定址的字卡快取:同輸入永不重畫;rasterizerId 進 key,換引擎全失效。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardGeometry, CardRequest, PillowRasterizer } from './rasterizer.js';

export function cardKey(req: CardRequest, rasterizerId: string): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        t: req.text,
        k: req.tokens ?? null,
        s: {
          f: req.style.fontFamily,
          z: req.style.fontSize,
          c: req.style.fill,
          o: req.style.stroke ?? null,
          h: req.style.highlight ?? null,
        },
        w: req.width,
        m: req.maxWidthFrac ?? 0.9,
        r: rasterizerId,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export interface CardResult extends CardGeometry {
  hash: string;
}

export class TextCardService {
  constructor(
    private projectDir: string,
    private rasterizer: PillowRasterizer,
  ) {}

  private dirAbs(): string {
    return join(this.projectDir, 'derived', 'text');
  }
  relBasePath(hash: string): string {
    return join('derived', 'text', `${hash}.base.png`);
  }

  async ensure(req: CardRequest): Promise<CardResult> {
    const hash = cardKey(req, this.rasterizer.id);
    const metaAbs = join(this.dirAbs(), `${hash}.json`);
    try {
      return { hash, ...(JSON.parse(await readFile(metaAbs, 'utf8')) as CardGeometry) };
    } catch {
      // miss → 產卡
    }
    await mkdir(this.dirAbs(), { recursive: true });
    const geo = await this.rasterizer.rasterize(
      req,
      join(this.dirAbs(), `${hash}.base.png`),
      req.tokens?.length ? join(this.dirAbs(), `${hash}.hl.png`) : undefined,
    );
    await writeFile(metaAbs, JSON.stringify(geo));
    return { hash, ...geo };
  }
}
```

- [ ] **Step 4: app.ts 端點**

`extras` 加 `textCards?: TextCardService`;插入:

```ts
app.use(
  '/text-card',
  express.static(join(projectDir, 'derived', 'text'), {
    fallthrough: false,
    immutable: true,
    maxAge: '365d', // 內容定址:URL 變 = 內容變
  }),
);
app.post('/text-card/preview', (req, res, next) => {
  void (async () => {
    const svc = extras?.textCards;
    if (!svc) {
      res.status(503).json({ error: 'text cards unavailable' });
      return;
    }
    const b = req.body as Partial<CardRequest>;
    if (!b || typeof b.text !== 'string' || !b.style) {
      res.status(400).json({ error: 'need text + style' });
      return;
    }
    res.json(await svc.ensure({ ...b, width: b.width ?? store.doc.canvas.width } as CardRequest));
  })().catch(next);
});
```

(注意順序:`app.post('/text-card/preview')` 要在 `app.use('/text-card', static)` **之前**,否則被 static 的 fallthrough:false 攔掉。)

index.ts:`const textCards = new TextCardService(projectDir, raster);` 傳入 extras。

- [ ] **Step 5: 跑測試 + 全 server**

Run: `npx vitest run server/test/textCards.test.ts && npx vitest run server/test`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/textCards.ts server/src/app.ts server/src/index.ts server/test/textCards.test.ts
git commit -m "feat(server): TextCardService 內容雜湊快取 + /text-card 端點 + preview 產卡通道"
```

---

### Task 4: 字幕卡同步(命令後 debounce 重產 + WS `textCards` 廣播 + 載入預熱)

**Files:**

- Modify: `shared/src/types.ts`(WsServerMsg 加 variant)
- Create: `server/src/cardSync.ts`
- Modify: `server/src/wsHub.ts`(接 sync;連線時補發最新對照)
- Modify: `server/src/index.ts`(建 sync、啟動預熱)
- Test: `server/test/cardSync.test.ts`

**Interfaces:**

- `WsServerMsg` 新 variant:`| { type: 'textCards'; entries: Array<{ id: string; hash: string }> }`(僅字幕;文字 overlay 的卡走 doc.imagePath,不需要對照表)
- Produces:

  ```ts
  export function capToCardRequest(cap: CaptionItem, canvasWidth: number): CardRequest;
  export class CaptionCardSync {
    constructor(store: ProjectStore, svc: TextCardService, debounceMs?: number);
    latest: Array<{ id: string; hash: string }>; // 連線補發用
    onReady?: (entries: Array<{ id: string; hash: string }>) => void;
    schedule(): void; // debounce 後 runNow
    runNow(): Promise<Array<{ id: string; hash: string }>>;
  }
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
// server/test/cardSync.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { TextCardService } from '../src/textCards.js';
import { CaptionCardSync, capToCardRequest } from '../src/cardSync.js';
import { DEFAULT_CAPTION_STYLE } from '@vidcut/shared';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-cs-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed captions', (d) => {
    d.tracks.captions = [
      { id: 'c1', text: '第一句', start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE },
      {
        id: 'c2',
        text: '第二句',
        start: 1,
        duration: 1,
        style: DEFAULT_CAPTION_STYLE,
        tokens: [
          { text: '第二', start: 1, end: 1.5 },
          { text: '句', start: 1.5, end: 2 },
        ],
      },
    ];
  });
  return { store, svc: new TextCardService(dir, raster) };
}

describe('CaptionCardSync', () => {
  it('capToCardRequest: 逐詞字幕帶 tokens 文字序列', async () => {
    const { store } = await setup();
    const req = capToCardRequest(store.doc.tracks.captions[1]!, 1080);
    expect(req.tokens).toEqual(['第二', '句']);
    expect(req.width).toBe(1080);
  });

  it('runNow 產出每句的 hash 並記在 latest', async () => {
    const { store, svc } = await setup();
    const sync = new CaptionCardSync(store, svc, 10);
    const entries = await sync.runNow();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe('c1');
    expect(sync.latest).toEqual(entries);
  }, 30_000);

  it('schedule 是 debounce:密集呼叫只跑一次 onReady', async () => {
    const { store, svc } = await setup();
    const sync = new CaptionCardSync(store, svc, 50);
    let calls = 0;
    sync.onReady = () => {
      calls += 1;
    };
    sync.schedule();
    sync.schedule();
    sync.schedule();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(1);
  }, 30_000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/cardSync.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

types.ts `WsServerMsg` union 加(放 `renderProgress` variant 旁):

```ts
  | { type: 'textCards'; entries: Array<{ id: string; hash: string }> }
```

```ts
// server/src/cardSync.ts — 字幕變更後重產字卡並通知 UI。debounce 吸收連續命令(拖時間軸、批量刪句)。
import type { CaptionItem } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';

export function capToCardRequest(cap: CaptionItem, canvasWidth: number): CardRequest {
  return {
    text: cap.text,
    ...(cap.tokens?.length ? { tokens: cap.tokens.map((t) => t.text) } : {}),
    style: {
      fontFamily: cap.style.fontFamily,
      fontSize: cap.style.fontSize,
      fill: cap.style.fill,
      ...(cap.style.stroke ? { stroke: cap.style.stroke } : {}),
      ...(cap.style.highlight ? { highlight: cap.style.highlight } : {}),
    },
    width: canvasWidth,
  };
}

export class CaptionCardSync {
  latest: Array<{ id: string; hash: string }> = [];
  onReady?: (entries: Array<{ id: string; hash: string }>) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private store: ProjectStore,
    private svc: TextCardService,
    private debounceMs = 300,
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow().catch((e: unknown) => {
        console.warn('caption card sync failed:', (e as Error).message);
      });
    }, this.debounceMs);
  }

  async runNow(): Promise<Array<{ id: string; hash: string }>> {
    if (this.running) {
      this.schedule(); // 正在跑就改排下一輪(取最新 doc)
      return this.latest;
    }
    this.running = true;
    try {
      const doc = this.store.doc;
      const entries: Array<{ id: string; hash: string }> = [];
      for (const cap of doc.tracks.captions) {
        const r = await this.svc.ensure(capToCardRequest(cap, doc.canvas.width));
        entries.push({ id: cap.id, hash: r.hash });
      }
      this.latest = entries;
      this.onReady?.(entries);
      return entries;
    } finally {
      this.running = false;
    }
  }
}
```

wsHub.ts:`WsDeps` 加 `cardSync?: CaptionCardSync`;`store.onChange` 內 patch 廣播後加:

```ts
if (cardSync && e.patches.some((p) => p.path[0] === 'tracks' && p.path[1] === 'captions')) {
  cardSync.schedule();
}
```

attachWs 開頭接上廣播與連線補發:

```ts
if (cardSync) {
  cardSync.onReady = (entries) => {
    const msg: WsServerMsg = { type: 'textCards', entries };
    for (const client of wss.clients) send(client, msg);
  };
}
// wss.on('connection') 裡,send(ws, full()) 之後:
if (cardSync && cardSync.latest.length > 0)
  send(ws, { type: 'textCards', entries: cardSync.latest });
```

index.ts:建 `const cardSync = new CaptionCardSync(store, textCards);` 傳入 attachWs deps;listen 後 `cardSync.schedule();`(啟動預熱,錯誤已在 runNow 內吞)。

- [ ] **Step 4: 跑測試 + 全 server + typecheck**

Run: `npx vitest run server/test/cardSync.test.ts && npx vitest run server/test && npm run typecheck`
Expected: 全 PASS(UI 的 applyServerMsg 對未知 type 走 patch 分支——**確認 project.ts 對 `textCards` 不會 resync 迴圈**:`applyServerMsg` 的 fallthrough 是 patch 處理,未知 type 會撞 `msg.version` undefined → 回 'resync' → 無窮迴圈。**必須**在 UI `project.ts` 先加 no-op case:`if (msg.type === 'textCards') return 'ok';`——本 task 一併改,Phase 3 才真正消費)

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts server/src/cardSync.ts server/src/wsHub.ts server/src/index.ts ui/src/stores/project.ts server/test/cardSync.test.ts
git commit -m "feat(server): 字幕卡 debounce 同步 + WS textCards 廣播 + 啟動預熱"
```

---

### Task 4b: 匯出字卡接上字型表(補 spec §4 的缺口)

> 2026-08-03 由 Task 4 審查發現:`render.ts` 的 `renderCaptionCard` payload **從未傳 fontFamily/fontPath**,
> 匯出字卡仍走 text_card.py 的硬編候選鏈,而預覽(Task 2 之後)走字型表 —— 兩邊字體會分歧,
> 正是 spec §4「fontFamily 欄位自此生效」要消滅的東西。原計畫沒有任何 task 接上這條。

**Files:**

- Modify: `server/src/render.ts`(`renderCaptionCard` payload 加 `fontPath`;新增模組級 resolver 注入)
- Modify: `server/src/index.ts`(啟動時把字型 resolver 注入 render 模組)
- Test: `server/test/render-fonts.test.ts`

**Interfaces:**

- Consumes:`fontResolver(table)`(Task 2,`server/src/fonts.ts`)
- Produces:

  ```ts
  // server/src/render.ts
  /** 注入字型解析器(啟動時由 index.ts 呼叫)。未注入時 payload 的 fontPath 為 null,
   *  text_card.py 退回既有候選鏈——舊行為,不會壞。 */
  export function setCaptionFontResolver(fn: (family: string) => string | undefined): void;
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
// server/test/render-fonts.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCaptionCard, setCaptionFontResolver } from '../src/render.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { loadFontTable, fontResolver } from '../src/fonts.js';
import { DEFAULT_CAPTION_STYLE } from '@vidcut/shared';

afterEach(() => setCaptionFontResolver(() => undefined)); // 測試間不互相污染

const cap = { id: 'c1', text: '字型測試', start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE };

describe('匯出字卡的字型解析', () => {
  it('注入 resolver 後,匯出字卡與預覽字卡走同一個字型檔(視覺輸出一致)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
    const raster = new PillowRasterizer(() => undefined);
    try {
      const table = await loadFontTable(raster);
      const resolve = fontResolver(table);
      raster.resolveFontPath = resolve;
      setCaptionFontResolver(resolve);

      // 匯出路徑產一張
      const rel = await renderCaptionCard(dir, cap, 1080);
      // 預覽路徑產一張(同文字/同樣式/同寬)
      const previewPath = join(dir, 'preview.png');
      await raster.rasterize(
        {
          text: cap.text,
          style: {
            fontFamily: cap.style.fontFamily,
            fontSize: cap.style.fontSize,
            fill: cap.style.fill,
            stroke: cap.style.stroke,
          },
          width: 1080,
        },
        previewPath,
      );
      // 同字型 → 同排版 → PNG 尺寸(IHDR 寬高)必相同
      const [exp, prev] = await Promise.all([readFile(join(dir, rel)), readFile(previewPath)]);
      expect(exp.subarray(16, 24)).toEqual(prev.subarray(16, 24));
    } finally {
      raster.dispose();
    }
  }, 30_000);

  it('未注入 resolver 時仍可產卡(舊行為不壞)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
    const rel = await renderCaptionCard(dir, cap, 1080);
    expect(rel).toContain('derived/captions');
  }, 30_000);
});
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run server/test/render-fonts.test.ts`(`setCaptionFontResolver` 不存在)
- [ ] **Step 3: 實作**——`render.ts` 模組級加:

```ts
let captionFontResolver: (family: string) => string | undefined = () => undefined;
/** 注入字型解析器(啟動時由 index.ts 呼叫)。未注入 → fontPath null → text_card.py 退回候選鏈。 */
export function setCaptionFontResolver(fn: (family: string) => string | undefined): void {
  captionFontResolver = fn;
}
```

`renderCaptionCard` 的 payload 加一欄(放在 `width` 之後):

```ts
    fontPath: captionFontResolver(cap.style.fontFamily) ?? null,
```

`index.ts` 在 `rasterizer.resolveFontPath = fontResolver(fonts);` 那行之後加:

```ts
setCaptionFontResolver(fontResolver(fonts));
```

- [ ] **Step 4: 跑測試** — `npx vitest run server/test/render-fonts.test.ts` PASS
- [ ] **Step 5: 回歸** — `npx vitest run server/test/render.test.ts server/test/captions-karaoke.test.ts server/test/render-t1.test.ts && npm run typecheck`
- [ ] **Step 6: Commit**

```bash
git add server/src/render.ts server/src/index.ts server/test/render-fonts.test.ts
git commit -m "fix(server): 匯出字卡接上字型表(fontFamily 對成品生效,預覽與成品同字體)"
```

---

### Task 5: 階段 1 文檔檢查點

**Files:**

- Modify: `HANDOFF.md`(現況表加一列「字幕 WYSIWYG 階段 1」;架構地圖加 rasterizer/fonts/textCards/cardSync 四檔)
- Modify: `docs/superpowers/specs/2026-08-03-caption-wysiwyg-design.md`(§12 表格階段 1 打勾,記錄實際落差若有)
- Modify: `server/src/mcp.ts` instructions(**只在**本階段有動到工具語意時;階段 1 沒動 MCP → 確認不需要,寫明「已檢查,無需更新」)

- [ ] **Step 1: 更新 HANDOFF.md 現況與程式碼地圖**(新檔案各一行職責描述,格式照既有表)
- [ ] **Step 2: spec §12 階段 1 標記完成;把 spec 改成與實作一致**——已知兩處刻意偏差要寫回 spec:①`derived/text` 孤兒檔清理延後(不在本計畫);②命令路徑產卡失敗改為「拒絕命令回 commandError」而非 spec §9 的「stale 標記補產」(更簡單且不會出現字圖不一致的中間態)
- [ ] **Step 3: 檢查 CLAUDE.md**——階段 1 無新指令、無行為變更 → 應不需改;若 Task 1–4 期間發現新坑(如 python 版本問題),補進 CLAUDE.md 或 HANDOFF
- [ ] **Step 4: 跑完整驗證**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全綠(lint 忽略 `.claude/worktrees/` 的既有噪音)

- [ ] **Step 5: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-08-03-caption-wysiwyg-design.md
git commit -m "docs: 字幕 WYSIWYG 階段 1(光柵器地基)完成,同步 HANDOFF 與 spec"
```

---

## 階段 2:可編輯文字 overlay

### Task 6: OverlayText 型別 + 命令層驗證 + resolveTextCommand

**Files:**

- Modify: `shared/src/types.ts`(OverlayItem.text、updateOverlay patch 擴充)
- Modify: `server/src/commands.ts`(text 驗證)
- Create: `server/src/textOverlays.ts`
- Modify: `server/src/wsHub.ts`(command 處理改 async、先 resolve)
- Test: `server/test/textOverlays.test.ts`

**Interfaces:**

- types:
  ```ts
  export interface OverlayText {
    text: string;
    fontFamily: string;
    fontSize: number;
    fill: string;
    stroke?: string;
    /** 換行寬 0–1 相對畫布,預設 0.9 */
    maxWidth?: number;
  }
  // OverlayItem 加:text?: OverlayText;(imagePath 註解改為「文字 overlay 時=伺服器產物,勿手動指定」)
  // updateOverlay 的 patch:Partial<Pick<OverlayItem, 'start'|'duration'|'position'|'anchor'|'text'|'imagePath'>>
  ```
- Produces:

  ```ts
  export function overlayTextToCardRequest(t: OverlayText, canvasWidth: number): CardRequest;
  /** addOverlay/updateOverlay 含 text 時:先產卡,把 imagePath 寫進同一個命令 → 單次 mutate 原子生效 */
  export async function resolveTextCommand(
    svc: TextCardService,
    store: ProjectStore,
    cmd: Command,
  ): Promise<Command>;
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
// server/test/textOverlays.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { TextCardService } from '../src/textCards.js';
import { resolveTextCommand } from '../src/textOverlays.js';
import type { Command, OverlayItem } from '@vidcut/shared';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-to-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  return { dir, store, svc: new TextCardService(dir, raster) };
}

const TEXT = {
  text: '大標題',
  fontFamily: 'Heiti TC',
  fontSize: 72,
  fill: '#ffffff',
  stroke: '#000000',
};
const ADD: Command = {
  name: 'addOverlay',
  overlay: {
    id: 'ov1',
    imagePath: '',
    text: TEXT,
    start: 0,
    duration: 3,
    position: { x: 0.5, y: 0.4, scale: 1 },
  } as OverlayItem,
};

describe('resolveTextCommand + 命令層', () => {
  it('addOverlay 帶 text:resolve 後 imagePath 指向實存的字卡,applyCommand 一次成立', async () => {
    const { dir, store, svc } = await setup();
    const resolved = await resolveTextCommand(svc, store, ADD);
    const r = applyCommand(store, 'human', resolved);
    expect(r.ok).toBe(true);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('大標題');
    expect(ov.imagePath).toMatch(/^derived\/text\/[0-9a-f]{16}\.base\.png$/);
    expect((await stat(join(dir, ov.imagePath))).size).toBeGreaterThan(0);
  }, 30_000);

  it('updateOverlay 改 text:text 與 imagePath 在同一版本一起變(原子)', async () => {
    const { store, svc } = await setup();
    applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD));
    const before = store.doc.tracks.overlays[0]!.imagePath;
    const cmd: Command = {
      name: 'updateOverlay',
      id: 'ov1',
      patch: { text: { ...TEXT, text: '改標題' } },
    };
    const r = applyCommand(store, 'human', await resolveTextCommand(svc, store, cmd));
    expect(r.ok).toBe(true);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('改標題');
    expect(ov.imagePath).not.toBe(before);
  }, 30_000);

  it('無 text 的命令原樣通過(既有排名 PNG 行為不變)', async () => {
    const { store, svc } = await setup();
    const cmd: Command = {
      name: 'addOverlay',
      overlay: {
        id: 'png1',
        imagePath: 'assets/x.png',
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0, scale: 1 },
      },
    };
    expect(await resolveTextCommand(svc, store, cmd)).toBe(cmd);
  });

  it('驗證:text overlay 空字串被拒;text overlay 的 imagePath 空(未 resolve)被拒', async () => {
    const { store } = await setup();
    const bad1: Command = {
      name: 'addOverlay',
      overlay: {
        ...(ADD as Extract<Command, { name: 'addOverlay' }>).overlay,
        text: { ...TEXT, text: '  ' },
      },
    };
    expect(applyCommand(store, 'human', bad1).ok).toBe(false);
    expect(applyCommand(store, 'human', ADD).ok).toBe(false); // imagePath 仍是 ''
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/textOverlays.test.ts`
Expected: FAIL

- [ ] **Step 3: types.ts + commands.ts + textOverlays.ts**

commands.ts 在 `addOverlay` 驗證裡加(updateOverlay 同理):

```ts
if (o.text) {
  if (o.text.text.trim() === '') return { ok: false, error: 'overlay text must not be empty' };
  if (o.text.fontSize <= 0) return { ok: false, error: 'fontSize must be > 0' };
  if (o.imagePath === '')
    return { ok: false, error: 'text overlay card not generated (server error)' };
}
```

```ts
// server/src/textOverlays.ts — 文字 overlay 的「命令前置」:產卡並把 imagePath 併進同一個命令。
// 這樣 applyCommand 仍是同步、一次 mutate 內 text 與 imagePath 原子生效(spec §6)。
import type { Command, OverlayText } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';

export function overlayTextToCardRequest(t: OverlayText, canvasWidth: number): CardRequest {
  return {
    text: t.text,
    style: {
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      fill: t.fill,
      ...(t.stroke ? { stroke: t.stroke } : {}),
    },
    width: canvasWidth,
    maxWidthFrac: t.maxWidth ?? 0.9,
  };
}

export async function resolveTextCommand(
  svc: TextCardService,
  store: ProjectStore,
  cmd: Command,
): Promise<Command> {
  if (cmd.name === 'addOverlay' && cmd.overlay.text) {
    const r = await svc.ensure(overlayTextToCardRequest(cmd.overlay.text, store.doc.canvas.width));
    return { ...cmd, overlay: { ...cmd.overlay, imagePath: svc.relBasePath(r.hash) } };
  }
  if (cmd.name === 'updateOverlay' && cmd.patch.text) {
    const r = await svc.ensure(overlayTextToCardRequest(cmd.patch.text, store.doc.canvas.width));
    return { ...cmd, patch: { ...cmd.patch, imagePath: svc.relBasePath(r.hash) } };
  }
  return cmd;
}
```

wsHub.ts command 分支改:

```ts
} else if (msg.type === 'command') {
  void (async () => {
    const cmd = deps.textCards
      ? await resolveTextCommand(deps.textCards, store, msg.cmd)
      : msg.cmd;
    const result = applyCommand(store, 'human', cmd);
    if (!result.ok) send(ws, { type: 'commandError', reqId: msg.reqId, error: result.error });
  })().catch((e: unknown) => {
    send(ws, { type: 'commandError', reqId: msg.reqId, error: `字卡產生失敗:${(e as Error).message}` });
  });
}
```

(`WsDeps` 加 `textCards?: TextCardService`;index.ts 傳入。)

- [ ] **Step 4: 跑測試 + 全 server + typecheck**

Run: `npx vitest run server/test/textOverlays.test.ts && npx vitest run server/test && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts server/src/commands.ts server/src/textOverlays.ts server/src/wsHub.ts server/src/index.ts server/test/textOverlays.test.ts
git commit -m "feat: 可編輯文字 overlay 資料模型 + 命令原子產卡(render.ts 零改動)"
```

---

### Task 7: MCP 文字 overlay 支援 + 描述同步

**Files:**

- Modify: `server/src/mcp.ts`(overlaySchema 加 text;add_overlay/update_overlay 先 resolve;McpDeps 加 textCards;instructions 提文字 overlay)
- Test: `server/test/mcp-optim.test.ts`(加案例)

**Interfaces:**

- Consumes: Task 6 的 `resolveTextCommand`、Task 3 的 `TextCardService`
- MCP schema 新增:

  ```ts
  const overlayTextSchema = z
    .object({
      text: z.string().min(1),
      fontFamily: z.string(),
      fontSize: z.number().positive(),
      fill: z.string(),
      stroke: z.string().optional(),
      maxWidth: z.number().min(0.1).max(1).optional(),
    })
    .strict();
  ```

- [ ] **Step 1: 寫失敗測試**(mcp-optim.test.ts 加,仿既有 call() 風格)

```ts
it('add_overlay with text creates an editable text overlay (server-made card)', async () => {
  const r = await call('add_overlay', {
    overlay: {
      id: 'txt1',
      imagePath: '',
      text: { text: 'MCP 文字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
      start: 0,
      duration: 2,
      position: { x: 0.5, y: 0.3, scale: 1 },
    },
  });
  expect(r.isError).toBeFalsy();
  const ov = store.doc.tracks.overlays.find((o) => o.id === 'txt1')!;
  expect(ov.text?.text).toBe('MCP 文字');
  expect(ov.imagePath).toMatch(/derived\/text\//);

  const upd = await call('update_overlay', {
    id: 'txt1',
    patch: { text: { text: '改過', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' } },
  });
  expect(upd.isError).toBeFalsy();
  expect(store.doc.tracks.overlays.find((o) => o.id === 'txt1')!.text?.text).toBe('改過');
}, 60_000);
```

(beforeAll 的 `McpDeps` 要補 `textCards: new TextCardService(dir, new PillowRasterizer(() => undefined))`——rasterizer 記得 afterAll dispose。)

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/mcp-optim.test.ts -t "text overlay"`
Expected: FAIL

- [ ] **Step 3: 實作**——overlaySchema 加 `text: overlayTextSchema.optional()`(schema `.describe('可編輯文字 overlay:伺服器自動產字卡並維護 imagePath;imagePath 傳空字串即可')`);add_overlay/update_overlay handler 改 async:

```ts
async ({ overlay, ifVersion }) => {
  const cmd = await resolveTextCommand(deps.textCards!, store, {
    name: 'addOverlay', overlay: overlay as OverlayItem,
  });
  return writeReply(aiWrite(store, cmd, ifVersion));
},
```

instructions 段補一句:「文字類 overlay 用 add_overlay 帶 text(伺服器產字卡,imagePath 給空字串);純圖 overlay 照舊給 imagePath。」

- [ ] **Step 4: 跑全 server 測試 + typecheck**

Run: `npx vitest run server/test && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp.ts server/test/mcp-optim.test.ts
git commit -m "feat(mcp): add_overlay/update_overlay 支援 text(描述同步,遵守 CLAUDE.md 鐵則)"
```

---

### Task 8: UI:Toolbar「Text」鈕 + Inspector 文字編輯欄位

**Files:**

- Modify: `ui/src/timeline/Toolbar.tsx`(Overlay 鈕旁加 Text 鈕)
- Modify: `ui/src/panels/Inspector.tsx`(overlay 有 text 時顯示編輯欄位)
- Test: `ui/src/panels/panels.test.tsx`(Inspector 文字欄位)、`ui/src/timeline/Timeline.test.tsx` 或既有 Toolbar 測試位置(Text 鈕)

**Interfaces:**

- Consumes: `sendCommand`(ws.ts)、Task 6 的 OverlayText 型別
- UI 慣例: 樣式走 theme 原生控件,icon 用 lucide-react(`Type`)

- [ ] **Step 1: 寫失敗測試**(仿 panels.test.tsx 既有 Inspector 測試:塞含 text overlay 的 doc → 斷言 textarea 存在、改字 blur 後送出 `updateOverlay` 且 patch.text.text 為新值)

```tsx
it('text overlay: Inspector 顯示文字欄位,改字送 updateOverlay(text 完整物件)', () => {
  const doc = fixtureDoc();
  doc.tracks.overlays = [
    {
      id: 'txt1',
      imagePath: 'derived/text/abc.base.png',
      text: { text: '原字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
      start: 0,
      duration: 2,
      position: { x: 0.5, y: 0.3, scale: 1 },
    },
  ];
  useProject.setState({ doc, version: 1 });
  useSelection.getState().select({ kind: 'overlay', id: 'txt1' });
  const { container } = render(<Inspector />);
  const ta = container.querySelector('textarea')!;
  expect(ta.value).toBe('原字');
  fireEvent.change(ta, { target: { value: '新字' } });
  fireEvent.blur(ta);
  const cmd = lastSentCommand(); // 既有測試的 sendCommand mock 取用方式
  expect(cmd).toMatchObject({
    name: 'updateOverlay',
    id: 'txt1',
    patch: { text: { text: '新字' } },
  });
});
```

(`fixtureDoc`/`lastSentCommand` 依 panels.test.tsx 既有 helper 名稱調整——該檔已有 sendCommand 的 mock 模式,沿用同一套,不自創。)

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -w @vidcut/ui -- run src/panels/panels.test.tsx`
Expected: FAIL

- [ ] **Step 3: Inspector 實作**——overlay 區塊(`selected.kind === 'overlay'`)裡,`ov.text` 存在時 render:

```tsx
{
  ov.text && (
    <>
      <label>Text</label>
      <textarea
        rows={2}
        defaultValue={ov.text.text}
        key={ov.id + ov.text.text}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== ov.text!.text) {
            send({ name: 'updateOverlay', id: ov.id, patch: { text: { ...ov.text!, text: v } } });
          }
        }}
      />
      <label>Font size</label>
      <input
        type="number"
        defaultValue={ov.text.fontSize}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (n > 0)
            send({
              name: 'updateOverlay',
              id: ov.id,
              patch: { text: { ...ov.text!, fontSize: n } },
            });
        }}
      />
      <label>Fill</label>
      <input
        type="color"
        defaultValue={ov.text.fill}
        onChange={(e) =>
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { text: { ...ov.text!, fill: e.target.value } },
          })
        }
      />
    </>
  );
}
```

(patch.text 一律送**完整 OverlayText**——伺服器端 resolve 需要全欄位重產卡,partial merge 會讓 hash 對不上。)

- [ ] **Step 4: Toolbar 實作**——Overlay 上傳 label 旁:

```tsx
<button
  className="icon-btn"
  title="Add a text overlay at playhead"
  onClick={() => {
    const id = `ovtext_${Math.random().toString(36).slice(2, 8)}`;
    sendCommand({
      name: 'addOverlay',
      overlay: {
        id,
        imagePath: '',
        text: {
          text: '新文字',
          fontFamily: 'PingFang TC',
          fontSize: 64,
          fill: '#ffffff',
          stroke: '#000000',
        },
        start: usePlayback.getState().time,
        duration: 3,
        position: { x: 0.5, y: 0.4, scale: 1 },
      },
    });
    useSelection.getState().select({ kind: 'overlay', id });
  }}
>
  <Type size={13} /> Text
</button>
```

- [ ] **Step 5: 跑 UI 測試 + build**

Run: `npm run test -w @vidcut/ui -- run && npm run build -w @vidcut/ui`
Expected: 全 PASS、build 成功

- [ ] **Step 6: Commit**

```bash
git add ui/src/timeline/Toolbar.tsx ui/src/panels/Inspector.tsx ui/src/panels/panels.test.tsx
git commit -m "feat(ui): Text overlay 新增鈕 + Inspector 文字/字級/顏色編輯"
```

---

### Task 9: 階段 2 文檔檢查點

- [ ] **Step 1: HANDOFF.md**:現況表更新;「新 MCP 能力」段記 add_overlay/update_overlay 的 text
- [ ] **Step 2: spec §12 階段 2 打勾**;`docs/ROADMAP.md` 若列了文字 overlay 相關項,同步狀態
- [ ] **Step 3: CLAUDE.md 檢查**:無新指令 → 通常不需改;若 UI 操作有新慣例(Text 鈕),HANDOFF 記即可
- [ ] **Step 4: 驗證**:`npm test && npm run typecheck && npm run lint`
- [ ] **Step 5: 手動煙測**(可選但建議):`npx tsx server/src/index.ts projects/demo` + 瀏覽器按 Text 鈕 → 改字 → render → 成品有字
- [ ] **Step 6: Commit**(docs 檔案)

---

## 階段 3:字幕所見即所得

### Task 10: shared 純函數 `karaokeClip`

**Files:**

- Modify: `shared/src/captions.ts`(或同目錄新檔 `cards.ts`,依 shared 現有慣例:captions.ts 已聚焦字幕,放這裡)
- Test: `shared/test/captions.test.ts`(既有測試檔加 describe)

**Interfaces:**

- Produces:

  ```ts
  export interface TokenBox {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  /** 逐詞揭色的 CSS clip-path。active<0 → null(hl 層整個不顯示)。pad=描邊外擴補償 */
  export function karaokeClip(boxes: TokenBox[], active: number, pad?: number): string | null;
  // 回傳 `path('M.. Z M.. Z')`:0..active 每個 box 一個矩形子路徑(先 pad 外擴)。
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
describe('karaokeClip', () => {
  const boxes = [
    { x: 100, y: 10, w: 50, h: 70 },
    { x: 150, y: 10, w: 60, h: 70 },
    { x: 80, y: 80, w: 90, h: 70 }, // 第二行
  ];
  it('active < 0 → null', () => {
    expect(karaokeClip(boxes, -1)).toBeNull();
  });
  it('active=0 → 只含第一個矩形', () => {
    const p = karaokeClip(boxes, 0, 0)!;
    expect(p).toBe("path('M100,10 h50 v70 h-50 Z')");
  });
  it('active=2 → 三個子路徑,含第二行', () => {
    const p = karaokeClip(boxes, 2, 0)!;
    expect(p.match(/M/g)).toHaveLength(3);
    expect(p).toContain('M80,80');
  });
  it('pad 外擴矩形', () => {
    expect(karaokeClip([boxes[0]!], 0, 4)!).toBe("path('M96,6 h58 v78 h-58 Z')");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run shared/test/captions.test.ts`
- [ ] **Step 3: 實作**

```ts
export interface TokenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function karaokeClip(boxes: TokenBox[], active: number, pad = 0): string | null {
  if (active < 0 || boxes.length === 0) return null;
  const rects = boxes
    .slice(0, Math.min(active + 1, boxes.length))
    .map((b) => {
      const x = b.x - pad;
      const y = b.y - pad;
      const w = b.w + pad * 2;
      const h = b.h + pad * 2;
      return `M${x},${y} h${w} v${h} h${-w} Z`;
    })
    .join(' ');
  return `path('${rects}')`;
}
```

- [ ] **Step 4: 跑測試** — PASS
- [ ] **Step 5: Commit** — `git add shared/src/captions.ts shared/test/captions.test.ts && git commit -m "feat(shared): karaokeClip 逐詞揭色 clip-path 純函數"`

---

### Task 11: UI:1080 座標空間 + 字卡直出 + karaoke + fallback

**Files:**

- Modify: `ui/src/stores/project.ts`(captionCards map + textCards 訊息真正消費)
- Create: `ui/src/player/CaptionLayer.tsx`
- Modify: `ui/src/player/Player.tsx`(字幕/overlay 層搬進 1080 空間;量測 stage 寬)
- Test: `ui/src/player/CaptionLayer.test.tsx` + 更新 `ui/src/player/Player.test.tsx` 既有字幕斷言

**Interfaces:**

- project store 加:
  ```ts
  captionCards: Record<string, string>; // capId → hash(初始 {},模組級常數 fallback)
  // applyServerMsg case 'textCards' → set({ captionCards: Object.fromEntries(entries.map(e => [e.id, e.hash])) })
  ```
- `CaptionLayer` props:`{ captions: CaptionItem[]; cards: Record<string, string>; time: number }`——渲染在 **1080×1920 座標系**內(由 Player 的縮放 wrapper 包)
- 卡片幾何 meta:`GET /text-card/<hash>.json`,模組級 `Map<string, Promise<CardGeometry>>` 快取

- [ ] **Step 1: 寫失敗測試**(CaptionLayer.test.tsx:有 hash → `<img src="/text-card/<hash>.base.png">`;有 tokens 且 active≥0 → hl img 帶 clipPath;無 hash → DOM 文字 fallback 且 fontSize 為**全尺寸**(不再 /3);meta fetch 用 vi.stubGlobal('fetch', ...) mock)

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { CaptionLayer } from './CaptionLayer.js';
import type { CaptionItem } from '@vidcut/shared';

const CAP: CaptionItem = {
  id: 'c1',
  text: '你好世界',
  start: 0,
  duration: 2,
  style: {
    fontFamily: 'PingFang TC',
    fontSize: 64,
    fill: '#ffffff',
    y: 0.72,
    highlight: '#FCDE5A',
  },
  tokens: [
    { text: '你好', start: 0, end: 1 },
    { text: '世界', start: 1, end: 2 },
  ],
};
const META = {
  width: 1080,
  height: 92,
  lines: 1,
  tokens: [
    { x: 400, y: 8, w: 128, h: 76 },
    { x: 528, y: 8, w: 128, h: 76 },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => META })),
  );
});

describe('CaptionLayer', () => {
  it('有卡:render base img,播放到第二詞時 hl img 有 2 個矩形的 clip-path', async () => {
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'abc123' }} time={1.5} />,
    );
    await waitFor(() => {
      const imgs = container.querySelectorAll('img');
      expect(imgs).toHaveLength(2);
      expect(imgs[0]!.getAttribute('src')).toBe('/text-card/abc123.base.png');
      expect(imgs[1]!.getAttribute('src')).toBe('/text-card/abc123.hl.png');
      expect(imgs[1]!.style.clipPath).toContain('M');
    });
  });
  it('無卡:DOM 文字 fallback,字級為全尺寸 64px(1080 空間)', () => {
    const { container } = render(<CaptionLayer captions={[CAP]} cards={{}} time={0.5} />);
    expect(container.querySelector('img')).toBeNull();
    const div = [...container.querySelectorAll('div')].find((d) =>
      d.textContent?.includes('你好'),
    )!;
    expect(div.style.fontSize).toBe('64px');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `npm run test -w @vidcut/ui -- run src/player/CaptionLayer.test.tsx`
- [ ] **Step 3: 實作 CaptionLayer.tsx**

```tsx
// 1080×1920 座標系內的字幕層:有卡用卡(和成品同一張圖),沒卡退回 DOM 近似(舊行為)。
import { useEffect, useState } from 'react';
import { activeTokenIndex, karaokeClip, type CaptionItem } from '@vidcut/shared';

interface Geo {
  width: number;
  height: number;
  tokens?: Array<{ x: number; y: number; w: number; h: number }>;
}
const geoCache = new Map<string, Promise<Geo | null>>();
function fetchGeo(hash: string): Promise<Geo | null> {
  if (!geoCache.has(hash)) {
    geoCache.set(
      hash,
      fetch(`/text-card/${hash}.json`)
        .then((r) => (r.ok ? (r.json() as Promise<Geo>) : null))
        .catch(() => null),
    );
  }
  return geoCache.get(hash)!;
}

function CardCaption({ cap, hash, time }: { cap: CaptionItem; hash: string; time: number }) {
  const [geo, setGeo] = useState<Geo | null>(null);
  useEffect(() => {
    let live = true;
    void fetchGeo(hash).then((g) => live && setGeo(g));
    return () => {
      live = false;
    };
  }, [hash]);
  if (!geo) return null; // meta 到位前寧可空一幀,不畫錯的
  const active = activeTokenIndex(cap, time);
  const pad = cap.style.stroke ? Math.max(2, Math.floor(cap.style.fontSize / 16)) : 0;
  const clip = geo.tokens ? karaokeClip(geo.tokens, active, pad) : null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 1920 * cap.style.y, width: 1080 }}>
      <img src={`/text-card/${hash}.base.png`} width={geo.width} height={geo.height} alt="" />
      {clip && (
        <img
          src={`/text-card/${hash}.hl.png`}
          width={geo.width}
          height={geo.height}
          alt=""
          style={{ position: 'absolute', left: 0, top: 0, clipPath: clip }}
        />
      )}
    </div>
  );
}

function ApproxCaption({ cap, time }: { cap: CaptionItem; time: number }) {
  const active = activeTokenIndex(cap, time);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 1920 * cap.style.y,
        textAlign: 'center',
        fontFamily: cap.style.fontFamily,
        fontSize: cap.style.fontSize, // 1080 空間內就是真字級——/3 粗估正式退役
        color: cap.style.fill,
        WebkitTextStroke: cap.style.stroke ? `2px ${cap.style.stroke}` : undefined,
      }}
    >
      {cap.tokens?.length
        ? cap.tokens.map((t, i) => (
            <span
              key={i}
              style={{ color: i <= active ? (cap.style.highlight ?? cap.style.fill) : undefined }}
            >
              {t.text}
            </span>
          ))
        : cap.text}
    </div>
  );
}

export function CaptionLayer({
  captions,
  cards,
  time,
}: {
  captions: CaptionItem[];
  cards: Record<string, string>;
  time: number;
}) {
  return (
    <>
      {captions.map((c) =>
        cards[c.id] ? (
          <CardCaption key={c.id} cap={c} hash={cards[c.id]!} time={time} />
        ) : (
          <ApproxCaption key={c.id} cap={c} time={time} />
        ),
      )}
    </>
  );
}
```

- [ ] **Step 4: Player.tsx 改造**——stage div 加 ref + ResizeObserver 量寬(`const [stageW, setStageW] = useState(0)`);原字幕 map 與 overlay map 移進縮放 wrapper:

```tsx
<div
  style={{
    position: 'absolute',
    left: 0,
    top: 0,
    width: 1080,
    height: 1920,
    transformOrigin: 'top left',
    transform: `scale(${stageW / 1080})`,
    pointerEvents: 'none',
  }}
>
  {plan.overlays.map((o) => (
    <img
      key={o.id}
      src={o.src}
      className={fxAdded.has(o.id) ? 'fx-enter' : undefined}
      alt=""
      style={{
        position: 'absolute',
        left: 1080 * o.position.x,
        top: 1920 * o.position.y,
        transform: `translate(-50%, 0) scale(${o.position.scale})`,
        transformOrigin: 'top center',
        maxWidth: 1080 * 0.9,
      }}
    />
  ))}
  <CaptionLayer captions={plan.captions} cards={captionCards} time={time} />
</div>
```

`captionCards` 從 `useProject((s) => s.captionCards)` 取(store 初始值用模組級常數 `NO_CARDS: Record<string,string> = {}`,**selector 禁 new reference**);project.ts 的 textCards no-op case 改為真正 set。overlay 原本的 `maxWidth: '90%'` 換算成 1080 空間(972px)。既有 `Karaoke` 元件與舊字幕 div 刪除(被 CaptionLayer 取代)。

- [ ] **Step 5: 更新 Player 既有測試**——Player.test.tsx 對字幕的斷言改成:mock ResizeObserver(jsdom 沒有,`vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })`)、斷言 fallback 路徑 fontSize 為 `64px`(取代原本 /3 的斷言);overlay 斷言 left/top 改 1080 空間值
- [ ] **Step 6: 跑 UI 全測試 + build** — `npm run test -w @vidcut/ui -- run && npm run build -w @vidcut/ui` → 全 PASS
- [ ] **Step 7: Commit**

```bash
git add ui/src/player/CaptionLayer.tsx ui/src/player/CaptionLayer.test.tsx ui/src/player/Player.tsx ui/src/player/Player.test.tsx ui/src/stores/project.ts
git commit -m "feat(ui): 預覽字幕改字卡直出(1080 座標空間,廢除 fontSize/3),karaoke 兩卡+clip-path"
```

---

### Task 12: 三段式打字(本地近似 → 預覽卡 → 命令)+ @font-face

**Files:**

- Create: `ui/src/stores/editDraft.ts`
- Modify: `ui/src/panels/CaptionList.tsx`(打字時餵 draft + debounce 預覽卡)
- Modify: `ui/src/player/CaptionLayer.tsx`(draft 覆寫)
- Modify: `ui/src/App.tsx`(啟動 fetch /api/fonts 注入 @font-face)
- Test: `ui/src/stores/editDraft.test.ts`、CaptionLayer.test.tsx 加案例

**Interfaces:**

- Produces:
  ```ts
  interface EditDraftState {
    caption: { id: string; text: string; previewHash: string | null } | null;
    setText(id: string, text: string): void; // 同 id 保留 previewHash?否——文字變了就清 previewHash
    setPreview(id: string, hash: string): void; // 僅當 id 仍是當前 draft 才收
    clear(): void;
  }
  export const useEditDraft: UseBoundStore<StoreApi<EditDraftState>>;
  ```
- CaptionLayer 改吃 `draft?: EditDraftState['caption']`:draft 命中該句時,previewHash 有 → 用它當卡(無 tokens 的單卡);否則 ApproxCaption 顯示 draft.text

- [ ] **Step 1: 寫失敗測試**

```ts
// ui/src/stores/editDraft.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditDraft } from './editDraft.js';

beforeEach(() => useEditDraft.getState().clear());

describe('editDraft', () => {
  it('setText 建 draft 並清 previewHash', () => {
    useEditDraft.getState().setText('c1', '哈');
    useEditDraft.getState().setPreview('c1', 'h1');
    useEditDraft.getState().setText('c1', '哈囉');
    expect(useEditDraft.getState().caption).toEqual({ id: 'c1', text: '哈囉', previewHash: null });
  });
  it('setPreview 只在 id 吻合時生效(過期回應丟棄)', () => {
    useEditDraft.getState().setText('c1', 'x');
    useEditDraft.getState().setPreview('c2', 'stale');
    expect(useEditDraft.getState().caption?.previewHash).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實作 store**

```ts
import { create } from 'zustand';

interface DraftCaption {
  id: string;
  text: string;
  previewHash: string | null;
}
interface EditDraftState {
  caption: DraftCaption | null;
  setText: (id: string, text: string) => void;
  setPreview: (id: string, hash: string) => void;
  clear: () => void;
}

export const useEditDraft = create<EditDraftState>((set, get) => ({
  caption: null,
  setText: (id, text) => set({ caption: { id, text, previewHash: null } }),
  setPreview: (id, hash) => {
    const cur = get().caption;
    if (cur?.id === id) set({ caption: { ...cur, previewHash: hash } });
  },
  clear: () => set({ caption: null }),
}));
```

- [ ] **Step 4: CaptionList 接線**——draft input 的 `onChange` 加:

```ts
useEditDraft.getState().setText(cap.id, e.target.value);
schedulePreview(cap, e.target.value); // 模組級 debounce 80ms
```

```ts
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePreview(cap: CaptionItem, text: string): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    void fetch('/text-card/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, style: cap.style, width: 1080 }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ hash: string }>) : null))
      .then((res) => res && useEditDraft.getState().setPreview(cap.id, res.hash));
  }, 80);
}
```

`commit(cap)` 與 Escape 路徑加 `useEditDraft.getState().clear();`。

- [ ] **Step 5: CaptionLayer draft 覆寫**——`CaptionLayer` 加 prop;Player 傳 `useEditDraft((s) => s.caption)`:

```tsx
{captions.map((c) => {
  if (draft?.id === c.id) {
    const draftCap = { ...c, text: draft.text, tokens: undefined };
    return draft.previewHash ? (
      <CardCaption key={c.id} cap={draftCap} hash={draft.previewHash} time={time} />
    ) : (
      <ApproxCaption key={c.id} cap={draftCap} time={time} />
    );
  }
  return cards[c.id] ? ( /* 同前 */ ) : ( /* 同前 */ );
})}
```

- [ ] **Step 6: @font-face 注入**(App.tsx useEffect,一次性):

```ts
useEffect(() => {
  void fetch('/api/fonts')
    .then((r) => (r.ok ? (r.json() as Promise<Array<{ id: string; family: string }>>) : []))
    .then((fonts) => {
      const css = fonts
        .map((f) => `@font-face { font-family: '${f.family}'; src: url('/fonts/${f.id}'); }`)
        .join('\n');
      const el = document.createElement('style');
      el.id = 'server-fonts';
      el.textContent = css;
      document.head.appendChild(el);
    });
}, []);
```

(近似預覽從此用「伺服器那顆字型檔」,和字卡同源;瀏覽器端 family 名稱與 CaptionStyle.fontFamily 一致即自動生效。)

- [ ] **Step 7: 跑 UI 全測試 + build** — 全 PASS
- [ ] **Step 8: Commit**

```bash
git add ui/src/stores/editDraft.ts ui/src/stores/editDraft.test.ts ui/src/panels/CaptionList.tsx ui/src/player/CaptionLayer.tsx ui/src/player/CaptionLayer.test.tsx ui/src/player/Player.tsx ui/src/App.tsx
git commit -m "feat(ui): 三段式即時改字(本地近似→80ms 預覽卡→命令)+ @font-face 同源字型"
```

---

### Task 13: 階段 3 文檔檢查點 + 真瀏覽器抽查

- [ ] **Step 1: 真瀏覽器抽查**(headless chromium,量縮放正確性——這是 phase 3 的驗收核心):`npm run build -w @vidcut/ui`,起 server 對 demo 專案,用 CDP 驗:字幕層 wrapper 的 `transform` scale ≈ stage寬/1080(三種視窗尺寸);寫成一次性腳本即可,正式回歸腳本在 Task 16
- [ ] **Step 2: HANDOFF.md**:字幕段全面改寫——「PNG 字卡雙端同源(預覽=成品),一詞一卡僅渲染端殘留(待兩卡化)」;程式碼地圖加 CaptionLayer/editDraft/cardSync
- [ ] **Step 3: spec §12 階段 3 打勾**;`vidcut-project` 記憶更新(WYSIWYG 上線、fontSize/3 已废)
- [ ] **Step 4: CLAUDE.md 檢查**:若「UI 驗證的陷阱」需補(如 ResizeObserver stub、clip-path path() 語法),加進去
- [ ] **Step 5: 驗證**:`npm test && npm run typecheck && npm run lint && npm run build -w @vidcut/ui`
- [ ] **Step 6: Commit**(docs)

---

## 階段 4:預覽拖曳 + 吸附

### Task 14: shared 純函數 `snapBBox`

**Files:**

- Create: `shared/src/snap.ts`(+ `shared/src/index.ts` re-export,照既有 export 慣例)
- Test: `shared/test/snap.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface BBox {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  export interface SnapGuide {
    axis: 'x' | 'y';
    pos: number;
  }
  /** bbox 為畫布 px(1080×1920)。目標:水平中心、垂直中心、上/下安全邊距(5%)。
   *  回吸附後的 bbox 左上角與命中導線。threshold 同為畫布 px。 */
  export function snapBBox(
    b: BBox,
    canvas: { w: number; h: number },
    threshold?: number, // 預設 16
  ): { x: number; y: number; guides: SnapGuide[] };
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, it, expect } from 'vitest';
import { snapBBox } from '../src/snap.js';

const CANVAS = { w: 1080, h: 1920 };

describe('snapBBox', () => {
  it('bbox 中心接近畫布水平中心 → 吸附並回 x 導線', () => {
    // bbox 寬 200,中心在 550(離 540 差 10 < 16)
    const r = snapBBox({ x: 450, y: 100, w: 200, h: 80 }, CANVAS);
    expect(r.x).toBe(440); // 中心對齊 540
    expect(r.guides).toContainEqual({ axis: 'x', pos: 540 });
  });
  it('超出閾值不動、無導線', () => {
    const r = snapBBox({ x: 300, y: 100, w: 200, h: 80 }, CANVAS);
    expect(r.x).toBe(300);
    expect(r.guides).toHaveLength(0);
  });
  it('上緣接近安全邊距(96)→ 吸 y', () => {
    const r = snapBBox({ x: 0, y: 90, w: 100, h: 100 }, CANVAS);
    expect(r.y).toBe(96);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 96 });
  });
  it('下緣接近 95% 線(1824)→ 吸 y(以下緣對齊)', () => {
    const r = snapBBox({ x: 0, y: 1730, w: 100, h: 100 }, CANVAS);
    expect(r.y).toBe(1724);
  });
  it('垂直中心吸附', () => {
    const r = snapBBox({ x: 0, y: 915, w: 100, h: 100 }, CANVAS); // 中心 965,離 960 差 5
    expect(r.y).toBe(910);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 960 });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `npx vitest run shared/test/snap.test.ts`
- [ ] **Step 3: 實作**

```ts
// shared/src/snap.ts — 預覽畫布吸附。一律吃「實際 bbox」:overlay 的 position 錨點
// 不對稱(x=中心、y=上緣),用錨點算置中必偏,呼叫端先換算成 bbox 再進來。
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SnapGuide {
  axis: 'x' | 'y';
  pos: number;
}

const SAFE_FRAC = 0.05;

export function snapBBox(
  b: BBox,
  canvas: { w: number; h: number },
  threshold = 16,
): { x: number; y: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let { x, y } = b;

  // 水平:bbox 中心 vs 畫布中心
  const cx = canvas.w / 2;
  if (Math.abs(b.x + b.w / 2 - cx) <= threshold) {
    x = cx - b.w / 2;
    guides.push({ axis: 'x', pos: cx });
  }

  // 垂直:三個候選取最近的一個(中心、安全上緣、安全下緣)
  const cands: Array<{ delta: number; y: number; pos: number }> = [];
  const cy = canvas.h / 2;
  cands.push({ delta: Math.abs(b.y + b.h / 2 - cy), y: cy - b.h / 2, pos: cy });
  const top = canvas.h * SAFE_FRAC;
  cands.push({ delta: Math.abs(b.y - top), y: top, pos: top });
  const bottom = canvas.h * (1 - SAFE_FRAC);
  cands.push({ delta: Math.abs(b.y + b.h - bottom), y: bottom - b.h, pos: bottom });
  const best = cands.sort((a, c) => a.delta - c.delta)[0]!;
  if (best.delta <= threshold) {
    y = best.y;
    guides.push({ axis: 'y', pos: best.pos });
  }

  return { x, y, guides };
}
```

- [ ] **Step 4: 跑測試** — PASS(注意測試 3:y=90 離 top=96 差 6;離 center 差很多;離 bottom 差很多 → 吸 top ✓)
- [ ] **Step 5: Commit** — `git add shared/src/snap.ts shared/test/snap.test.ts shared/src/index.ts && git commit -m "feat(shared): snapBBox 畫布吸附純函數(bbox 制,避開錨點不對稱)"`

---

### Task 15: UI:畫布拖曳(overlay x/y、字幕 y)+ 導線

**Files:**

- Create: `ui/src/player/dragLayer.ts`(拖曳數學純函數:pointer delta → 新 bbox → snap → 新 position/style.y)
- Modify: `ui/src/player/Player.tsx` + `CaptionLayer.tsx`(pointer 事件、選取、導線、拖曳中本地覆寫)
- Test: `ui/src/player/dragLayer.test.ts`

**Interfaces:**

- Produces(dragLayer.ts):

  ```ts
  /** overlay 拖曳:回吸附後 position(0–1)與導線。bboxW/H = 該 overlay 目前顯示尺寸(畫布 px) */
  export function dragOverlay(
    startPos: { x: number; y: number }, // 拖曳起點的 position
    deltaCanvas: { dx: number; dy: number }, // pointer 位移換算成畫布 px
    bbox: { w: number; h: number },
    canvas: { w: number; h: number },
  ): { position: { x: number; y: number }; guides: SnapGuide[] };
  /** 字幕拖曳:只動 style.y(0–1,夾在 0..1-高度佔比) */
  export function dragCaption(
    startY: number,
    dyCanvas: number,
    cardH: number,
    canvasH: number,
  ): { y: number; guides: SnapGuide[] };
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, it, expect } from 'vitest';
import { dragOverlay, dragCaption } from './dragLayer.js';

const CANVAS = { w: 1080, h: 1920 };

describe('dragOverlay', () => {
  it('位移換算 position;錨點不對稱正確(x 中心/y 上緣)', () => {
    // 起點 {0.5, 0.4},bbox 400×100,拖 +108px/-192px
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 108, dy: -192 }, { w: 400, h: 100 }, CANVAS);
    // 未觸發吸附時:x = 0.5+0.1 = 0.6, y = 0.4-0.1 = 0.3
    expect(r.position.x).toBeCloseTo(0.6);
    expect(r.position.y).toBeCloseTo(0.3);
  });
  it('拖近水平中心會吸回 0.5 並給導線', () => {
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 10, dy: 0 }, { w: 400, h: 100 }, CANVAS);
    expect(r.position.x).toBeCloseTo(0.5);
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true);
  });
});

describe('dragCaption', () => {
  it('y 位移換算 + 夾限', () => {
    expect(dragCaption(0.72, 192, 92, 1920).y).toBeCloseTo(0.82);
    expect(dragCaption(0.9, 500, 92, 1920).y).toBeLessThanOrEqual(1 - 92 / 1920);
    expect(dragCaption(0.1, -500, 92, 1920).y).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實作 dragLayer.ts**

```ts
import { snapBBox, type SnapGuide } from '@vidcut/shared';

export function dragOverlay(
  startPos: { x: number; y: number },
  deltaCanvas: { dx: number; dy: number },
  bbox: { w: number; h: number },
  canvas: { w: number; h: number },
): { position: { x: number; y: number }; guides: SnapGuide[] } {
  // position → bbox 左上角(x 錨=中心、y 錨=上緣)
  const raw = {
    x: startPos.x * canvas.w - bbox.w / 2 + deltaCanvas.dx,
    y: startPos.y * canvas.h + deltaCanvas.dy,
    w: bbox.w,
    h: bbox.h,
  };
  const s = snapBBox(raw, canvas);
  return {
    position: {
      x: Math.min(1, Math.max(0, (s.x + bbox.w / 2) / canvas.w)),
      y: Math.min(1, Math.max(0, s.y / canvas.h)),
    },
    guides: s.guides,
  };
}

export function dragCaption(
  startY: number,
  dyCanvas: number,
  cardH: number,
  canvasH: number,
): { y: number; guides: SnapGuide[] } {
  // 字幕卡全寬置中,x 固定;只吸 y 軸(x 導線濾掉)
  const s = snapBBox(
    { x: 0, y: startY * canvasH + dyCanvas, w: 1080, h: cardH },
    { w: 1080, h: canvasH },
  );
  const y = Math.min(1 - cardH / canvasH, Math.max(0, s.y / canvasH));
  return { y, guides: s.guides.filter((g) => g.axis === 'y') };
}
```

- [ ] **Step 4: Player 接線**——1080 wrapper 的 `pointerEvents` 改 `'auto'`(僅 overlay img 與字幕卡 div;影片/背景仍 none);拖曳狀態存 `useRef`(模式同 Timeline:move 只 setState 本地覆寫 + 導線,up 才 `sendCommand`):

```tsx
// Player 內
const dragRef = useRef<{
  kind: 'overlay' | 'caption';
  id: string;
  startX: number;
  startY: number;
  startPos: { x: number; y: number };
  bbox: { w: number; h: number };
} | null>(null);
const [dragOverride, setDragOverride] = useState<{
  id: string;
  position?: { x: number; y: number };
  y?: number;
} | null>(null);
const [guides, setGuides] = useState<SnapGuide[]>([]);
const scale = stageW / 1080;

const onLayerPointerMove = (e: React.PointerEvent) => {
  const d = dragRef.current;
  if (!d) return;
  const delta = { dx: (e.clientX - d.startX) / scale, dy: (e.clientY - d.startY) / scale };
  if (d.kind === 'overlay') {
    const r = dragOverlay(d.startPos, delta, d.bbox, { w: 1080, h: 1920 });
    setDragOverride({ id: d.id, position: r.position });
    setGuides(r.guides);
  } else {
    const r = dragCaption(d.startPos.y, delta.dy, d.bbox.h, 1920);
    setDragOverride({ id: d.id, y: r.y });
    setGuides(r.guides);
  }
};
const onLayerPointerUp = () => {
  const d = dragRef.current;
  const o = dragOverride;
  dragRef.current = null;
  setGuides([]);
  setDragOverride(null);
  if (!d || !o) return;
  if (d.kind === 'overlay' && o.position) {
    const scale0 = doc.tracks.overlays.find((x) => x.id === d.id)?.position.scale ?? 1;
    sendCommand({
      name: 'updateOverlay',
      id: d.id,
      patch: { position: { ...o.position, scale: scale0 } },
    });
  } else if (d.kind === 'caption' && o.y !== undefined) {
    const cap = doc.tracks.captions.find((c) => c.id === d.id);
    if (cap)
      sendCommand({ name: 'updateCaption', id: d.id, patch: { style: { ...cap.style, y: o.y } } });
  }
};
```

overlay img `onPointerDown`:`select({kind:'overlay',id})`、`e.currentTarget.setPointerCapture(e.pointerId)`、記 `dragRef`(bbox 取 `e.currentTarget.getBoundingClientRect()` 除以 scale;position.scale 保留原值——上面 patch 的 scale 用 `ov.position.scale` 而非 1,實作時修正)。字幕卡外層 div 同理(kind:'caption',bbox.h = geo.height)。拖曳中該項用 `dragOverride` 的值蓋掉 doc 值。導線:

```tsx
{
  guides.map((g, i) =>
    g.axis === 'x' ? (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: g.pos,
          top: 0,
          width: 2,
          height: 1920,
          background: 'var(--warn, #eab308)',
        }}
      />
    ) : (
      <div
        key={i}
        style={{
          position: 'absolute',
          top: g.pos,
          left: 0,
          height: 2,
          width: 1080,
          background: 'var(--warn, #eab308)',
        }}
      />
    ),
  );
}
```

- [ ] **Step 5: 跑 UI 全測試 + build** — 全 PASS
- [ ] **Step 6: Commit**

```bash
git add ui/src/player/dragLayer.ts ui/src/player/dragLayer.test.ts ui/src/player/Player.tsx ui/src/player/CaptionLayer.tsx
git commit -m "feat(ui): 預覽畫布直接拖曳 overlay/字幕 + 中心/安全邊距吸附導線"
```

---

### Task 16: 真瀏覽器回歸 + 階段 4 文檔檢查點

**Files:**

- Create: `ui/e2e/canvas-direct.mjs`(仿 panel-affordance.mjs 的 CDP harness)
- Modify: `package.json`(`"verify:canvas": "node ui/e2e/canvas-direct.mjs"`)
- Modify: `HANDOFF.md`、`CLAUDE.md`、spec、`docs/ROADMAP.md`

- [ ] **Step 1: 寫 e2e 腳本**(前置:server 起著 + ui/dist 最新,同 verify:panels)。三個檢查:

```js
// 1. 縮放正確:字幕層 wrapper 的 scale ≈ stage 寬/1080(±1%)
const ok1 = await evalJs(`(() => {
  const v = document.querySelector('video');
  const stage = v.parentElement;
  const layer = [...stage.querySelectorAll(':scope > div')].find((d) => d.style.transform.includes('scale'));
  if (!layer) return 'no layer';
  const m = /scale\\(([\\d.]+)\\)/.exec(layer.style.transform);
  const expect = stage.getBoundingClientRect().width / 1080;
  return Math.abs(Number(m[1]) - expect) / expect < 0.01 || \`\${m[1]} vs \${expect}\`;
})()`);

// 2. 拖曳 overlay:合成 pointer 事件把第一個 overlay 往右拖 50px → poll /api/project 位置變了
// (Input.dispatchMouseEvent mousePressed/mouseMoved/mouseReleased 於 overlay 中心)

// 3. 拖近水平中心時出現導線(拖到中心附近時查 DOM 有 width:2px 的縱線)
```

(完整 harness 複用 panel-affordance.mjs 的 findChrome/connect/send/evalJs;失敗蒐集後 exit 1。React 不同步 flush——事件後要下一次 evaluate 才讀 DOM,腳本裡 sleep 300ms。)

- [ ] **Step 2: 跑 e2e**

Run: `npm run build -w @vidcut/ui && npx tsx server/src/index.ts projects/demo &`(或已在跑的 server)`; npm run verify:canvas`
Expected: 3 項全過

- [ ] **Step 3: 文檔總收尾**
  - HANDOFF.md:現況表四階段全勾;「明天第一件事」段改為驗收指引(拖曳手感、打字體感);已知取捨移除「播放/渲染字級換算 fontSize/3 粗估」條(已修)
  - CLAUDE.md:指令段加 `npm run verify:canvas`(含前置條件);UI 驗證陷阱若有新坑(pointer capture、clip-path path())補上
  - spec §12 全勾;ROADMAP 同步
  - `server/src/mcp.ts` instructions 末次檢查:文字 overlay、字幕卡行為描述與實作一致
  - 記憶(`vidcut-project.md`):四階段完成、驗收待使用者
- [ ] **Step 4: 完整驗證**

Run: `npm test && npm run typecheck && npm run lint && npm run build -w @vidcut/ui && npm run verify:panels && npm run verify:canvas`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add ui/e2e/canvas-direct.mjs package.json HANDOFF.md CLAUDE.md docs/
git commit -m "test(e2e): 畫布直接操作真瀏覽器回歸 + 四階段文檔總收尾"
```

---

## 驗收總表(對照 spec §2 目標)

| spec 目標           | 驗證方式                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| 預覽=成品像素級一致 | Task 11(同一 hash 的卡)+ Task 13/16 真瀏覽器縮放檢查                        |
| 文字 overlay 可編輯 | Task 6–8 測試 + Task 9 手動煙測 render                                      |
| 拖曳+吸附           | Task 14–15 純函數測試 + Task 16 e2e                                         |
| 打字即時            | Task 12(draft store + 80ms debounce 測試)                                   |
| fontFamily 生效     | Task 2 字型表 + Task 12 @font-face 同源                                     |
| 文檔可靠完整        | Task 5/9/13/16 檢查點(HANDOFF/CLAUDE.md/spec/ROADMAP/MCP instructions/記憶) |
