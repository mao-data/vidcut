# 端帽把手 ＋ 拿掉 leadPad ＋ 窄片不外推 — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 時間軸選取項的 trim 把手改成「跟著 chip 圓角走的 6px 端帽＋2×14 深色刻痕」（使用者 2026-09-11 定案的方案 1），拿掉窄片把手外推（0.1s 極窄 clip 把手跑到 0s 左邊的溢出），並把 Plan 14 的 `leadPad`（前把手黑墊）從資料模型→命令層→MCP→render→播放器→UI 六層整個移除，前把手回到「拉到來源起點硬停、把手變 danger」；Plan 15 的拖曳中佔位黑墊（純 UI）保留。

**Architecture:** 三條線互相獨立、可分開驗收：(A) 純 CSS＋把手 class 的視覺改動；(B) 把手偏移算式從「-6 再外推」收斂成「選取恆 -6、未選取 0」；(C) leadPad 移除——先拆消費端（server 命令層／render／frame／MCP、UI player／timeline），最後才刪 shared 的型別與 helper，讓每個 task 結束時 `npm run typecheck` 都是綠的。既有專案檔的 `leadPad` 在 `ProjectStore.load` 一次性清掉（duration 扣掉 pad、刪鍵）。

**Tech Stack:** TypeScript、React 19、vitest（jsdom）、zod（MCP schema）、ffmpeg filtergraph 字串（render.ts）。驗證用 `npm run typecheck`／`npm run lint`／各 workspace `npx vitest run`；視覺用真瀏覽器截圖（見 Task 1 步驟）。

**Spec:** 本計畫即定案（使用者於 2026-09-10／11 對話中四次確認）：

1. 把手＝方案 1：端帽 6px（外圓角同 chip）＋刻痕 2px 寬 14px 高（`--card` 色）＋上下框維持 2px `--select-frame`；四種 chip（主軌 clip／音訊／字幕／overlay）都套。
2. 窄片不外推：選取時把手固定 `-6px`（12px 跨邊界置中），端帽永遠畫在 chip 內；命中區仍保留 6px 外溢。
3. 拿掉 `leadPad` 六層；Plan 15 拖曳中佔位（`trimPlaceholder`／`placeholderHead`／`placeholderTail`）**保留**。
4. 既有專案檔帶 `leadPad>0`：載入時自動清掉（`duration -= leadPad`，刪鍵；內容照舊從 `in` 播）。
5. 前把手拉到來源起點＝硬停（`trimIn` 既有 clamp `in>=0`），把手 `danger` 態、badge 附 ` · min`（鏡射 out 把手的 `atMax`／` · max`）。

## Global Constraints

- **worktree 內執行一切**：`/Users/maohua/Desktop/gi_+repo/ai-video-cut/.claude/worktrees/handle-caps`（分支 `handle-caps`，從 `main` 6584b85 開出）。**第一件事 `npm install`**（CLAUDE.md 一般規則：沒裝之前的 typecheck／測試結果一律不算數；自檢 `ls -l node_modules/@vidcut/shared` 要指向 worktree 自己的 `shared`）。
- **不要 `git add -A`**，只 stage 自己動過的路徑。
- **改 `server/src/mcp.ts` 後 `server/test/mcp-surface-snapshot.test.ts` 必紅**：先讀 diff 確認新描述屬實，再 `npx vitest run test/mcp-surface-snapshot.test.ts -u`。
- **`ui/src` 改完要 `npm run build -w @vidcut/ui`** 才會反映到 server；視覺驗證用第二台 server：`VIDCUT_PORT=3846 npx tsx server/src/index.ts projects/demo`（**不要**碰 :3845，那是主檢出的 server；**不要**用 `npm run demo`）。
- `MIN_CLIP_DURATION = 0.1`（`ui/src/timeline/dragMath.ts`、server 端 `commands.ts` 同名常數）不動。
- 把手命中區契約不動：未選取 6px 貼齊邊緣；選取 12px 跨邊界置中（6 內 6 外）。
- 每個 task 結束：`npm run typecheck` 綠、該 workspace 的相關測試綠、commit。

---

### Task 1：環境 ＋ 端帽把手視覺 ＋ 拿掉窄片外推（線 A、B）

**Files:**

- Modify: `ui/src/theme.css:2142-2240`（`.handle` 系列規則）
- Modify: `ui/src/timeline/ClipBlock.tsx:91-97`（`overflowOffset`）、`:322-347`（兩個把手 JSX）
- Modify: `ui/src/timeline/AudioChip.tsx:44-48`、`:96-110`
- Modify: `ui/src/timeline/Timeline.tsx:1770-1777`（`handleOffset`）、`:2096-2112`（overlay 把手）、`:2163-2179`（字幕把手）
- Test: `ui/src/timeline/ClipBlock.test.tsx:340-434`、`ui/src/timeline/AudioChip.peaksAbsent.test.tsx`（只需確認仍綠）

**Interfaces:**

- Produces: 每個 `.handle` 元素多一個方向 class：左把手 `handle in`、右把手 `handle out`（既有 `danger`／`accent` class 照舊疊加）。CSS 端帽靠 `.clipblk.selected .handle.in::before` / `.handle.out::before` 畫。

- [ ] **Step 1: 裝依賴、確認 symlink**

```bash
cd /Users/maohua/Desktop/gi_+repo/ai-video-cut/.claude/worktrees/handle-caps
npm install
ls -l node_modules/@vidcut/shared   # 必須 -> ../../shared（worktree 自己的）
git config core.hooksPath           # .githooks
npm run typecheck                   # 起點必須綠
```

- [ ] **Step 2: 改 ClipBlock 測試——窄片不外推、把手帶方向 class（先紅）**

把 `ui/src/timeline/ClipBlock.test.tsx` 裡這三個 `it`（340「選取且窄片（<28px）：兩把手向外溢出，互不重疊」、365「未選取窄片…不外溢」、386「final-review Minor 4 回歸釘…」）**整個刪掉**，換成下面三個（放在同一個 `describe('ClipBlock 把手：選取常駐 + 窄片外溢（Plan 11 Task 1）'` 裡；describe 名稱改成 `'ClipBlock 把手：選取常駐、恆 -6、不外推（2026-09-11 端帽定案）'`）：

```tsx
it('選取且窄片（<28px）：把手不再外推，偏移恆為 -6px（端帽永遠在 chip 內）', () => {
  const p = demoProject();
  // duration 0.1s * pps 40 = 4px：極窄（舊算式會外推到 -18px，左把手跑到 0s 左邊）
  const { container } = render(
    <ClipBlock
      p={p}
      clip={{ ...p.tracks.video[0], duration: 0.1 }}
      leftPx={0}
      pps={40}
      selected={true}
      animate={false}
      floating={false}
      onTrimStart={noop}
      onMoveStart={noop}
      onSelect={noop}
    />,
  );
  const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
  expect(left!.style.left).toBe('-6px');
  expect(right!.style.right).toBe('-6px');
});

it('未選取窄片：把手貼齊邊緣（0px），與寬片相同', () => {
  const p = demoProject();
  const { container } = render(
    <ClipBlock
      p={p}
      clip={{ ...p.tracks.video[0], duration: 0.5 }}
      leftPx={0}
      pps={40}
      selected={false}
      animate={false}
      floating={false}
      onTrimStart={noop}
      onMoveStart={noop}
      onSelect={noop}
    />,
  );
  const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
  expect(left!.style.left).toBe('0px');
  expect(right!.style.right).toBe('0px');
});

it('把手帶方向 class：左＝handle in、右＝handle out（端帽 CSS 靠這個分左右）', () => {
  const p = demoProject();
  const { container } = render(
    <ClipBlock
      p={p}
      clip={p.tracks.video[0]}
      leftPx={0}
      pps={40}
      selected={true}
      animate={false}
      floating={false}
      onTrimStart={noop}
      onMoveStart={noop}
      onSelect={noop}
    />,
  );
  const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
  expect(left!.className.split(' ')).toContain('in');
  expect(right!.className.split(' ')).toContain('out');
});
```

`436` 那個「相鄰窄片：選取的那個 z-index 抬升」測試**保留**（z-index 抬升邏輯不動）。

- [ ] **Step 3: 跑測試確認紅**

```bash
cd ui && npx vitest run src/timeline/ClipBlock.test.tsx
```

Expected: 上面三個 FAIL（`-18px` ≠ `-6px`；className 沒有 `in`／`out`）。

- [ ] **Step 4: ClipBlock.tsx——偏移恆 -6、把手加方向 class**

`ui/src/timeline/ClipBlock.tsx:88-97` 整段（從 `const NARROW_THRESHOLD = 28;` 到 `: 0;`）換成：

```ts
// 2026-09-11 端帽定案：選取態把手固定跨邊界置中（-6：12px 寬、6 內 6 外），
// **不再依內容寬外推**——舊的 NARROW_THRESHOLD(28px) 外推讓 0.1s 極窄 clip 的
// 左把手跑到 0s 左邊（看起來像負寬度）。端帽視覺畫在 chip 內側 6px，
// 極窄時兩個端帽貼在一起就是整個 chip，不需要外推來保留移動帶。
const SELECTED_HANDLE_W = 12;
const overflowOffset = selected ? -SELECTED_HANDLE_W / 2 : 0;
```

同檔上方 `contentW` 那行（`const contentW = w - placeholderHeadPx - placeholderTailPx;`）**保留**（filmstrip 裁切框仍用它）。

`:322` 的 `className={'handle' + (pad > 0 ? ' accent' : '')}` 改成 `className={'handle in' + (pad > 0 ? ' accent' : '')}`；
`:338` 的 `className={'handle' + (outAtMax ? ' danger' : '')}` 改成 `className={'handle out' + (outAtMax ? ' danger' : '')}`。

- [ ] **Step 5: AudioChip.tsx——同樣收斂**

`ui/src/timeline/AudioChip.tsx:44-48` 換成：

```ts
// 2026-09-11 端帽定案：同 ClipBlock，選取恆 -6、不外推。
const SELECTED_HANDLE_W = 12;
const overflowOffset = selected ? -SELECTED_HANDLE_W / 2 : 0;
```

`:97` `className="handle"` → `className="handle in"`；`:105` `className={'handle' + (outAtMax ? ' danger' : '')}` → `className={'handle out' + (outAtMax ? ' danger' : '')}`。

- [ ] **Step 6: Timeline.tsx——`handleOffset` 收斂、字幕／overlay 把手加 class**

`ui/src/timeline/Timeline.tsx:1770-1777` 換成（上方那段長註解改成兩行）：

```ts
// 2026-09-11 端帽定案：選取恆 -6（12px 跨邊界置中），不再依寬度外推——與
// ClipBlock／AudioChip 的 overflowOffset 同款（三處手動同步）。
const SELECTED_HANDLE_W = 12;
const handleOffset = (_w: number, isSel: boolean): number => (isSel ? -SELECTED_HANDLE_W / 2 : 0);
```

`:2097` overlay 左把手 `className="handle"` → `className="handle in"`；`:2105` 右把手 → `className="handle out"`；`:2164` 字幕左把手 → `className="handle in"`；`:2172` 右把手 → `className="handle out"`。

- [ ] **Step 7: theme.css——端帽 CSS**

把 `ui/src/theme.css` 裡 `.clipblk.selected .handle {` 到 `.clipblk.selected .handle:hover { ... }`（2026-09-10 那段「實心圓角方塊」規則，含前面的說明註解）整段換成：

```css
/* 2026-09-11 使用者定案（方案 1）：選取態把手＝**端帽**——chip 左右各 6px 的實色帽
 * （--select-frame，暗房白／紙上 ink），外側圓角跟著 chip 走（border-radius: inherit
 * 再把內側兩角歸零），上下框仍是 chip 上 2px 的 inset 環，框＋端帽讀成一個「框框」。
 * 中央一道 2px×14px 的 --card 刻痕標示可抓。把手本身（12px、跨邊界置中）維持透明，
 * 只當命中區；端帽畫在 `::before` 的 chip 內側那 6px（left/right: 6px 起）。 */
.handle {
  border-radius: inherit;
}
.clipblk.selected .handle {
  width: 12px;
  background: transparent;
}
.clipblk.selected .handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  background: var(--select-frame);
  border-radius: inherit;
}
.clipblk.selected .handle.in::before {
  left: 6px;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.clipblk.selected .handle.out::before {
  right: 6px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.clipblk.selected .handle::after {
  content: '';
  position: absolute;
  top: 50%;
  height: 14px;
  width: 2px;
  transform: translateY(-50%);
  border-radius: 1px;
  background: var(--card);
}
.clipblk.selected .handle.in::after {
  left: 8px; /* 6(帽左緣) + (6-2)/2 */
}
.clipblk.selected .handle.out::after {
  right: 8px;
}
.clipblk.selected .handle:hover {
  background: transparent;
}
```

接著把 danger／accent 的選取態規則改成蓋 `::before`（不是蓋 `background`）：

```css
.clipblk .handle.danger {
  background: color-mix(in srgb, var(--danger) 28%, transparent);
}
.clipblk .handle.danger:hover {
  background: color-mix(in srgb, var(--danger) 50%, transparent);
}
/* 選取態端帽整塊換 --danger，刻痕維持 --card。 */
.clipblk.selected .handle.danger,
.clipblk.selected .handle.danger:hover {
  background: transparent;
}
.clipblk.selected .handle.danger::before {
  background: var(--danger);
}
```

accent 同款（`.clipblk.selected .handle.accent::before { background: var(--accent-bright); }`，選取態 `.handle.accent`／`:hover` 的 background 設 transparent）。**Task 7 會把 accent 整組刪掉**，這裡先照改讓 Task 1 自己是完整的。

`.clipblk:hover .handle { background: var(--tint-28) }`／`.clipblk .handle:hover { background: var(--tint-50) }`（未選取 hover）**不動**。

- [ ] **Step 8: 跑測試、typecheck、build**

```bash
cd ui && npx vitest run src/timeline && cd .. && npm run typecheck && npm run lint && npm run build -w @vidcut/ui
```

Expected: 全綠（`Timeline.test.tsx` 有「selected class」測試，不受影響）。

- [ ] **Step 9: 真瀏覽器截圖驗收**

```bash
VIDCUT_PORT=3846 npx tsx server/src/index.ts projects/demo &   # 第二台 server
```

用 `/private/tmp/claude-501/-Users-maohua-Desktop-gi--repo/e212e66c-8cbd-4307-a968-fd442fda0626/scratchpad/shot.mjs` 的做法（CDP 點選主軌第一段 clip、截 dark＋paper），把網址改成 `http://127.0.0.1:3846/`。要看到：白色 6px 端帽貼齊 clip 圓角、刻痕置中、2px 白框；紙色是 ink 版。再用 `repro-trim.mjs`（同目錄，改 port）把右把手拖到底：`after` 的兩個 handle `x` 必須落在 clip 兩緣（left `styleL` 為 `-6px`、right `styleR` 為 `-6px`），左把手 `x >= clip.x - 6`。

- [ ] **Step 10: Commit**

```bash
git add ui/src/theme.css ui/src/timeline/ClipBlock.tsx ui/src/timeline/AudioChip.tsx ui/src/timeline/Timeline.tsx ui/src/timeline/ClipBlock.test.tsx
git commit -m "feat(ui): trim 把手改端帽（6px＋2×14 刻痕）並拿掉窄片外推——0.1s 極窄 clip 把手不再跑到 0s 左邊"
```

---

### Task 2：server 命令層拿掉 leadPad

**Files:**

- Modify: `server/src/commands.ts:222-245`（numericError）、`:636-683`（updateClip）、`:725-758`（addClip）、`:783-816`（setTimeline）、`:1047-1085`（splitAt）、`:1087-1165`（deleteSide）、`:1166-1238`（freezeFrame）、`:1240-1270`（extractAudio）
- Test: `server/test/commands-t1.test.ts:335-800`

**Interfaces:**

- Consumes: 目前 `shared` 仍匯出 `clipSourceTime`／`clipContentDuration`，本 task 後 `commands.ts` **不再 import 它們**（Task 8 才刪 helper）。
- Produces: 命令層對 `leadPad` 完全不認識（型別在 Task 8 刪除；本 task 先把讀寫全拿掉，typecheck 仍過因為欄位是 optional）。

- [ ] **Step 1: 刪 leadPad 專屬測試，補硬停回歸測試（先紅）**

`server/test/commands-t1.test.ts`：刪除下列 `describe` 整塊——`'updateClip：leadPad 邊界（Plan 14 Task 1）'`（335 起）、`'addClip：leadPad（Plan 14 Task 1）'`（497）、`'setTimeline：leadPad pass-through…'`（576）、`'splitAt：黑墊（Plan 14 Task 1）'`（633）、`'deleteBefore：黑墊切點…'`（698）、`'deleteAfter：黑墊切點…'`（744）、`'freezeFrame：黑墊（Plan 14 Task 1）'`（783 起，到該 describe 結束）。

在檔尾加：

```ts
describe('leadPad 已移除（2026-09-11）：命令層不再接受、也不再落盤這個欄位', () => {
  it('updateClip 的 patch 帶 leadPad 會被 strict 驗證擋掉（未知欄位）——或至少不落盤', async () => {
    const store = await freshStore();
    const clip = store.doc.tracks.video[0]!;
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: clip.id,
      // @ts-expect-error leadPad 已從 Command 型別移除（Task 8）；執行期也必須被忽略
      patch: { leadPad: 1 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]).not.toHaveProperty('leadPad');
  });

  it('updateClip：in+duration 超過來源長度被拒（不再有「內容長度」的減法）', async () => {
    const store = await freshStore();
    const clip = store.doc.tracks.video[0]!;
    const srcDur = store.doc.media.find((m) => m.id === clip.mediaId)!.probe.duration;
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: clip.id,
      patch: { in: 0, duration: srcDur + 1 },
    });
    expect(r.ok).toBe(false);
    expect(String((r as { error: string }).error)).toMatch(/exceeds source/);
  });
});
```

（`freshStore`／`applyCommand` 用該測試檔既有的 helper 名稱；開檔看前 40 行對齊實際名稱，若叫 `makeStore` 就改用它。）

- [ ] **Step 2: 跑測試確認紅**

```bash
cd server && npx vitest run test/commands-t1.test.ts
```

Expected: 第一個新測試 FAIL（目前 `leadPad: 1` 會落盤）。

- [ ] **Step 3: commands.ts——拿掉全部 leadPad 讀寫**

- `numericError`：刪 `optNum('patch.leadPad', cmd.patch.leadPad),`、`optNum(\`clips[${i}].leadPad\`, c.leadPad),`、`optNum('leadPad', cmd.leadPad),` 三行。
- `updateClip`：`:646-660` 換成

```ts
const nextIn = cmd.patch.in ?? clip.in;
const nextDur = cmd.patch.duration ?? clip.duration;
if (nextIn < 0) return { ok: false, error: 'in must be >= 0' };
if (nextDur < MIN_CLIP_DURATION)
  return { ok: false, error: `duration (${nextDur}) must be >= ${MIN_CLIP_DURATION}` };
if (nextIn + nextDur > srcDur + 1e-6) {
  return { ok: false, error: `in+duration (${nextIn + nextDur}) exceeds source ${srcDur}` };
}
```

並刪掉 mutate 裡 `if (cmd.patch.leadPad !== undefined) { ... }` 那段（含註解）。

- `addClip`：`:733-742` 換成

```ts
if (cmd.duration < MIN_CLIP_DURATION) {
  return { ok: false, error: `duration (${cmd.duration}) must be >= ${MIN_CLIP_DURATION}` };
}
if (cmd.in + cmd.duration > media.probe.duration + 1e-6) {
  return { ok: false, error: `clip out of bounds for ${cmd.mediaId}` };
}
```

刪 push 物件裡的 `...(cmd.leadPad ? { leadPad: cmd.leadPad } : {}),`。

- `setTimeline`：`:783-795` 換成

```ts
if (c.duration < MIN_CLIP_DURATION) {
  return {
    ok: false,
    error: `duration (${c.duration}) must be >= ${MIN_CLIP_DURATION} for ${c.mediaId}`,
  };
}
if (c.in + c.duration > media.probe.duration + 1e-6) {
  return { ok: false, error: `clip out of bounds for ${c.mediaId}` };
}
```

刪 map 物件裡的 `...(c.leadPad ? { leadPad: c.leadPad } : {}),`。

- `splitAt`：函式改成

```ts
function splitAt(store: ProjectStore, source: MutationSource, time: number): CommandResult {
  const clips = store.doc.tracks.video;
  const hit = clipAt(clips, time);
  if (!hit) return { ok: false, error: `no clip at ${time}s` };
  const clip = clips[hit.index]!;
  const left = hit.offset;
  const right = clip.duration - hit.offset;
  if (left < MIN_CLIP_DURATION || right < MIN_CLIP_DURATION) {
    return { ok: false, error: `split point too close to clip edge (${left}s / ${right}s)` };
  }
  return ok(
    store.mutate(source, `split ${clip.label ?? clip.id}`, (d) => {
      const c = d.tracks.video[hit.index]!;
      const second: VideoClip = { ...c, id: nanoid(6), in: c.in + left, duration: right };
      c.duration = left;
      d.tracks.video.splice(hit.index + 1, 0, second);
    }),
  );
}
```

- `deleteSide` 的 forEach 本體換成

```ts
clips.forEach((c, i) => {
  const s = starts[i]!;
  const e = s + c.duration;
  if (side === 'before') {
    if (e <= time) return; // 整段在左側 → 丟掉
    if (s < time) {
      const cut = time - s;
      const nextDur = c.duration - cut;
      if (nextDur < MIN_CLIP_DURATION) return;
      kept.push({ ...c, in: c.in + cut, duration: nextDur });
      return;
    }
    kept.push(c);
  } else {
    if (s >= time) return; // 整段在右側 → 丟掉
    if (e > time) {
      const rest = time - s;
      if (rest < MIN_CLIP_DURATION) return;
      kept.push({ ...c, duration: rest });
      return;
    }
    kept.push(c);
  }
});
```

函式上方那段 leadPad 語意註解刪掉，保留前兩行說明。

- `freezeFrame`：`const pad = clip.leadPad ?? 0;` 與 `atSource === null` 判斷刪掉，改 `const atSource = clip.in + hit.offset;`；`if (hit.offset < pad + MIN_CLIP_DURATION)` → `if (hit.offset < MIN_CLIP_DURATION)`；中段分支 `second` 的 `in: atSource` 不變、刪 `delete second.leadPad;`。上方長註解縮成「time 貼近頭尾不切、中間切兩段夾定格」。

- `extractAudio`：刪 `const pad = clip.leadPad ?? 0;`，`start: clipStart + pad` → `start: clipStart`，`duration: clipContentDuration(clip)` → `duration: clip.duration`。

- 檔頭 import：刪 `clipSourceTime,`、`clipContentDuration,`。

- [ ] **Step 4: 跑測試、typecheck**

```bash
cd server && npx vitest run test/commands-t1.test.ts test/commands.test.ts 2>/dev/null; cd .. && npm run typecheck
```

Expected: 綠。（`commands.test.ts` 若不存在忽略；跑 `npx vitest run test/commands` 涵蓋所有同名前綴。）

- [ ] **Step 5: Commit**

```bash
git add server/src/commands.ts server/test/commands-t1.test.ts
git commit -m "refactor(server): 命令層拿掉 leadPad——split/delete/freeze/extractAudio 回到純 in+duration 語意"
```

---

### Task 3：render.ts ＋ frame.ts 拿掉 leadPad

**Files:**

- Modify: `server/src/render.ts:10-11`（import）、`:312-330`、`:377-390`、`:413-420`、`:819-826`
- Modify: `server/src/frame.ts:4`、`:49-54`
- Delete: `server/test/render-leadpad.test.ts`
- Test: `server/test/render.test.ts:389-440`（刪 describe）

- [ ] **Step 1: 刪測試（先讓套件反映新世界）**

```bash
git rm server/test/render-leadpad.test.ts
```

`server/test/render.test.ts`：刪 `describe('leadPad 前把手黑墊（Plan 14 Task 2）'` 整塊。

- [ ] **Step 2: render.ts**

- `const contentDur = clipContentDuration(clip);` → `const contentDur = clip.duration;`（該迴圈內兩處用 `contentDur` 的 `-t` 維持不動）。
- 刪 `:377-390` 整段（`const pad = clip.leadPad ?? 0; if (pad > 0) { ... }` 與其註解）。
- 音訊鏈：刪 `const pad = clip.leadPad ?? 0;` 與 `const delay = ...;`，`aresample=44100${delay}[a${i}]` → `aresample=44100[a${i}]`。
- cover：`:819-826` 換成

```ts
const sourceTime = loc.clip.frozen ? loc.clip.in : loc.clip.in + loc.offsetInClip;
```

並把後面 `if (sourceTime === null) { ...黑幀... }` 分支整段刪掉（黑尾仍由上方 `output > total` 邏輯處理，不在這裡）。開檔確認該分支只服務 leadPad（註解寫「墊內回 null」）。

- import 刪 `clipContentDuration,`、`clipSourceTime,`。

- [ ] **Step 3: frame.ts**

`:53-54` 換成 `const sourceTime = loc.clip.in + loc.offsetInClip;`，刪 `if (sourceTime === null) return extractBlackFrame(...)`；import 刪 `clipSourceTime`（保留 `locate, outputDuration, totalDuration`）。

- [ ] **Step 4: 跑 render 測試（真 ffmpeg）＋ typecheck**

```bash
cd server && npx vitest run test/render test/frame 2>&1 | tail -8; cd .. && npm run typecheck
```

Expected: 綠（`render-blacktail` 等黑尾測試不受影響）。

- [ ] **Step 5: Commit**

```bash
git add server/src/render.ts server/src/frame.ts server/test/render.test.ts server/test/render-leadpad.test.ts
git commit -m "refactor(server): render/frame 拿掉 leadPad 的 tpad/adelay 與黑幀分支"
```

---

### Task 4：MCP 工具面拿掉 leadPad

**Files:**

- Modify: `server/src/mcp.ts:130-132`、`:225-232`、`:408-415`、`:548-550`、`:853-854`、`:1251-1254`、`:1268-1270`
- Test: `server/test/mcp-tools.test.ts:472-560`、`server/test/mcp-surface-snapshot.test.ts`（`-u`）

- [ ] **Step 1: 刪 leadPad 測試（先紅：snapshot 會紅）**

`server/test/mcp-tools.test.ts`：刪 `it('帶 leadPad：黑墊落進新 clip…')`（472）與 `describe('leadPad（Plan 14 Task 5）'` 整塊。

- [ ] **Step 2: mcp.ts**

- `projectSummary`：刪 `...(c.leadPad ? { leadPad: c.leadPad } : {}),` 與其上兩行註解。
- `clipPatchSchema`：刪 `leadPad: z.number().optional().describe(...)` 整段。
- `timelineClipSchema`（`:408`）：同上刪掉。
- instructions（`:548-550`）：刪掉以 `'A clip can also carry leadPad: ...'` 開頭到 `'...the same as the black tail past the main track.' +` 的三行。
- `get_frame` description（`:853-854`）：刪 `" A time inside a clip's leadPad (its black, silent lead) " + 'also returns a plain black frame, same as the black tail past the main track.'` 這一句（保留前後句）。
- `set_timeline` description（`:1251-1254`）：刪四行 leadPad 說明；`add_clip` description（`:1268-1270`）：刪三行。
- `add_clip` 的 `inputSchema` 若有 `leadPad`（往下看 `:1274` 之後）一併刪。

- [ ] **Step 3: 更新 snapshot 並確認 diff 只少了 leadPad**

```bash
cd server && npx vitest run test/mcp-surface-snapshot.test.ts 2>&1 | tail -5   # 先看紅的 diff
npx vitest run test/mcp-surface-snapshot.test.ts -u
git diff --stat test/__snapshots__/
git diff test/__snapshots__/ | grep "^[-+]" | grep -v "^[-+][-+]" | grep -vi "leadpad\|black, silent lead\|content length" ; echo "(上面應該沒有任何一行)"
npx vitest run test/mcp
```

Expected: 綠；snapshot diff 只有 leadPad 相關文字消失。

- [ ] **Step 4: typecheck + commit**

```bash
cd .. && npm run typecheck
git add server/src/mcp.ts server/test/mcp-tools.test.ts server/test/__snapshots__/mcp-surface.snap.json
git commit -m "refactor(mcp): 工具面拿掉 leadPad 參數與描述，snapshot 同步"
```

---

### Task 5：既有專案檔載入時清掉 leadPad

**Files:**

- Modify: `server/src/store.ts:89-98`
- Test: `server/test/store.test.ts`（檔尾加 describe）

**Interfaces:**

- Produces: `ProjectStore.load()` 讀到 `tracks.video[i].leadPad > 0` 時就地正規化：`duration -= leadPad`、刪 `leadPad` 鍵；其他欄位不動。純載入期一次性，不進 history、不 bump rev。

- [ ] **Step 1: 寫失敗測試**

`server/test/store.test.ts` 檔尾：

```ts
describe('載入正規化：舊專案的 leadPad（2026-09-11 移除）', () => {
  it('leadPad>0 的 clip：duration 扣掉 pad、鍵消失，in 不變；無 pad 的 clip 逐位元組不動', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-leadpad-'));
    const file = join(dir, 'project.json');
    const doc = createEmptyProject('p', 'p');
    doc.tracks.video = [
      { id: 'a', mediaId: 'm', in: 1, duration: 5, volume: 1, leadPad: 2 } as never,
      { id: 'b', mediaId: 'm', in: 0, duration: 3, volume: 1 },
    ];
    await writeFile(file, JSON.stringify({ rev: 7, ...doc }));
    const store = await ProjectStore.load(file);
    expect(store.doc.tracks.video[0]).toEqual({
      id: 'a',
      mediaId: 'm',
      in: 1,
      duration: 3,
      volume: 1,
    });
    expect(store.doc.tracks.video[1]).toEqual({
      id: 'b',
      mediaId: 'm',
      in: 0,
      duration: 3,
      volume: 1,
    });
    expect(store.version).toBe(7);
  });
});
```

（import 對齊該檔既有：`mkdtemp`/`writeFile` 來自 `node:fs/promises`、`tmpdir` 來自 `node:os`、`createEmptyProject` 來自 `@vidcut/shared`；若檔內已 import 就不要重複。）

- [ ] **Step 2: 跑測試確認紅**

```bash
cd server && npx vitest run test/store.test.ts
```

Expected: FAIL（`duration` 仍是 5、`leadPad` 仍在）。

- [ ] **Step 3: store.ts**

`load` 改成：

```ts
  static async load(filePath: string): Promise<ProjectStore> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const { rev, ...doc } = JSON.parse(raw) as ProjectFile;
      stripLegacyLeadPad(doc as Project);
      return new ProjectStore(filePath, doc as Project, rev ?? 0);
    } catch {
      const name = basename(dirname(filePath)) || 'untitled';
      return new ProjectStore(filePath, createEmptyProject(name, name));
    }
  }
```

檔尾（class 外）加：

```ts
/**
 * 2026-09-11：`leadPad`（Plan 14 前把手黑墊）已從資料模型移除。舊專案檔若還帶著它，
 * 載入時就地正規化：黑墊從時間軸長度扣掉、鍵刪除——內容照舊從 `in` 播、後面的 clip
 * 往前靠。只在載入期做一次、不進 history、不 bump rev；下一次任何 mutate 落盤時自然
 * 以正規化後的形狀寫回。
 */
function stripLegacyLeadPad(doc: Project): void {
  for (const c of doc.tracks.video as Array<VideoClip & { leadPad?: number }>) {
    if (typeof c.leadPad === 'number') {
      if (c.leadPad > 0) c.duration = Math.max(0, c.duration - c.leadPad);
      delete c.leadPad;
    }
  }
}
```

（`VideoClip` 若尚未 import，從 `@vidcut/shared` 加 type import。Task 8 刪掉型別後這裡靠交叉型別 `& { leadPad?: number }` 仍能編譯。）

- [ ] **Step 4: 綠 + commit**

```bash
npx vitest run test/store; cd .. && npm run typecheck
git add server/src/store.ts server/test/store.test.ts
git commit -m "feat(server): 載入舊專案時清掉 leadPad（duration 扣墊、刪鍵）"
```

---

### Task 6：播放器 plan.ts 拿掉 leadPad

**Files:**

- Modify: `ui/src/player/plan.ts:2`、`:78-175`（`TrimPreview`、`effectivePadFor`、`sourceFor`）與 `planAt` 內對 `effectivePadFor` 的用法
- Test: `ui/src/player/plan.test.ts:269-400`（刪 describe）、`ui/src/stores/playback.test.ts`（3 處提到 leadPad，改為不帶）

**Interfaces:**

- Produces: `export type TrimPreview = { clipId: string; in: number; placeholderHead?: number } | null;`（`leadPad` 欄位移除；`placeholderHead` 保留——Plan 15）。

- [ ] **Step 1: 刪測試、修 fixture（先紅）**

`plan.test.ts`：刪 `describe('planAt leadPad 前把手黑墊（Plan 14 Task 3）'` 整塊（269 起到其結尾）；`describe('planAt trimPreview.placeholderHead…')` **保留**。`playback.test.ts`：把 `setTrimPreview({ ..., leadPad: X })` 的 `leadPad` 欄位拿掉。

- [ ] **Step 2: plan.ts**

- `TrimPreview` 改成上面的三欄位形狀；上方註解只留 Plan 12（clipId/in）與 Plan 15（placeholderHead）兩段，刪 Plan 14 那段。
- 刪 `effectivePadFor` 整個函式。
- `sourceFor`：`effectiveClip` 改 `const effectiveIn = isTarget ? trimPreview!.in : clip.in;`；frozen 分支刪 `pad` 判斷，直接回 `sourceTime: effectiveIn`；非 frozen：`const sourceTime = effectiveIn + offsetInClip;`，刪 `if (sourceTime === null) return null;`。
- `planAt` 內若有 `effectivePadFor(...)`／`pad` 的 premount 分支（grep `effectivePad`），改成「offset 落在本 clip 內 → next 指向下一個 clip」的原始語意：刪掉「offset 落在黑墊內時 next 指向本 clip 內容起點」的分支。
- import 刪 `clipSourceTime`。

- [ ] **Step 3: 綠 + commit**

```bash
cd ui && npx vitest run src/player src/stores/playback.test.ts; cd .. && npm run typecheck
git add ui/src/player/plan.ts ui/src/player/plan.test.ts ui/src/stores/playback.test.ts
git commit -m "refactor(ui): 播放器 plan 拿掉 leadPad（TrimPreview 只剩 clipId/in/placeholderHead）"
```

---

### Task 7：時間軸 UI 拿掉 leadPad、前把手硬停＋danger

**Files:**

- Modify: `ui/src/timeline/dragMath.ts:19-49`（刪 `trimInPad`）
- Modify: `ui/src/timeline/Timeline.tsx:35`、`:255`、`:799-803`、`:866-876`（刪 `snapExtendedX`）、`:960-1030`（trim-in 分支）、`:1514-1528`（`inPad`→`inAtMinClipId`）、`:1611-1614`（badge）、`:1990-1995`（`ClipBlock` props）、commit 段（`const leadPad = ...`、`setPending` 的 `leadPad`、`setTrimPreview` 的 `leadPad`）
- Modify: `ui/src/timeline/ClipBlock.tsx`（`pad`/`padPx`、`clip-leadpad` 黑帶、`accent` class → `inAtMin` prop + `danger`）
- Modify: `ui/src/timeline/DragBadge.tsx:13`、`:69-80`
- Modify: `ui/src/theme.css`（刪 `.handle.accent` 三組規則）
- Modify: `ui/src/App.tsx`（不動——`[` 已是 `trimIn` 硬停）
- Test: `dragMath.test.ts:74-135`、`ClipBlock.test.tsx:540-672`（黑墊 describe）、`Timeline.trimFollow.test.tsx:1295-1477`、`DragBadge.test.tsx:58-80`

**Interfaces:**

- Consumes: Task 6 的 `TrimPreview`（無 `leadPad`）。
- Produces: `ClipBlock` 新 prop `inAtMin?: boolean`（in 把手 `danger`）；`DragBadgeContent` trim 變體 `{ kind: 'trim'; duration; delta; atMax?: boolean; atMin?: boolean }`，`atMin` → 附加 ` · min`。

- [ ] **Step 1: 改測試（先紅）**

1. `dragMath.test.ts`：刪 `describe('trimInPad…')` 整塊。
2. `DragBadge.test.tsx`：`describe('formatDragBadge：黑墊標記…')` 換成

```ts
describe('formatDragBadge：來源起點硬停標記（2026-09-11，取代黑墊 black +X.Xs）', () => {
  it('trim + atMin：附加 " · min"', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 8, delta: 2, atMin: true })).toBe(
      '8.0s (+2.0s) · min',
    );
  });
  it('trim 不帶 atMin／atMin:false：沒有 min 字樣', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 8, delta: 2 })).toBe('8.0s (+2.0s)');
    expect(formatDragBadge({ kind: 'trim', duration: 8, delta: 2, atMin: false })).toBe(
      '8.0s (+2.0s)',
    );
  });
});
```

3. `ClipBlock.test.tsx`：刪 `describe('ClipBlock 黑墊視覺（Plan 14 Task 4）'` 整塊；在「把手」describe 加：

```tsx
it('inAtMin：in 把手帶 danger class，out 把手不受影響', () => {
  const p = demoProject();
  const { container } = render(
    <ClipBlock
      p={p}
      clip={p.tracks.video[0]}
      leftPx={0}
      pps={40}
      selected={true}
      animate={false}
      floating={false}
      inAtMin={true}
      onTrimStart={noop}
      onMoveStart={noop}
      onSelect={noop}
    />,
  );
  const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
  expect(left!.className.split(' ')).toContain('danger');
  expect(right!.className.split(' ')).not.toContain('danger');
});
```

`describe('ClipBlock trim 佔位黑墊（Plan 15 Task 1）'` 裡凡是帶 `leadPad` 的 case（777「頭端佔位與真 leadPad 同時存在」、804）刪掉，其餘保留。

4. `Timeline.trimFollow.test.tsx`：`describe('主軌拖出黑墊的視覺語言（Plan 14 Task 4…）'`（1295 起到 1477）整塊換成：

```tsx
describe('來源起點硬停的視覺語言（2026-09-11，取代 Plan 14 黑墊）', () => {
  // c1：in=2 duration=6，往左拉超過 2s（80px @ 40pps）就頂到 in=0。
  const TO_ZERO_PX = 2 * PPS;

  it('trim-in 拖到來源起點：in 把手帶 danger class，out 把手不受影響；in 夾在 0', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 40, pointerId: 1, bubbles: true });
    });
    expect(left!.className).toContain('danger');
    expect(right!.className).not.toContain('danger');
    expect(container.textContent).toContain('8.0s (+2.0s) · min');
  });

  it('trim-in 未拖到起點：沒有 danger，badge 沒有 min', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true }); // -1s
    });
    expect(left!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('· min');
  });

  it('放手：送出的 updateClip 只有 in/duration，沒有 leadPad，且 in=0', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 40, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 100 - TO_ZERO_PX - 40, pointerId: 1, bubbles: true });
    });
    const cmd = sent.find((c) => c.name === 'updateClip');
    expect(cmd).toEqual({ name: 'updateClip', clipId: 'c1', patch: { in: 0, duration: 8 } });
  });
});
```

同檔其他 describe 若有 `leadPad`（grep），把該欄位刪掉。

- [ ] **Step 2: 跑測試確認紅**

```bash
cd ui && npx vitest run src/timeline/dragMath.test.ts src/timeline/DragBadge.test.tsx src/timeline/ClipBlock.test.tsx src/timeline/Timeline.trimFollow.test.tsx 2>&1 | tail -15
```

Expected: FAIL（`atMin`／`inAtMin` 不存在、trim-in 仍長黑墊）。

- [ ] **Step 3: dragMath.ts**

刪 `trimInPad` 函式與其註解（`:19-49`）。`trimIn`／`trimOut`／`trimPlaceholder`／`isAtSourceMax` 不動。加一支對稱 helper：

```ts
/** 主軌 in 把手是否已頂到來源起點（in<=0）——`trimIn` 的 clamp 讓 in 縮不了了。 */
export function isAtSourceMin(clip: Pick<VideoClip, 'in'>): boolean {
  return clip.in <= 0;
}
```

並在 `dragMath.test.ts` 加：

```ts
describe('isAtSourceMin', () => {
  it('in=0 為 true，in>0 為 false', () => {
    expect(isAtSourceMin({ in: 0 })).toBe(true);
    expect(isAtSourceMin({ in: 0.5 })).toBe(false);
  });
});
```

- [ ] **Step 4: DragBadge.tsx**

型別 `pad?: number` → `atMin?: boolean`；`formatDragBadge` 的 `if (content.pad && content.pad > 0) return ...black...` 換成 `if (content.atMin) return \`${base} · min\`;`；上方註解改為「`atMin`／`atMax` 互斥（in／out 把手各一）」。

- [ ] **Step 5: ClipBlock.tsx**

- props：加 `inAtMin = false` 與型別 `inAtMin?: boolean`（註解：「in 把手已頂到來源起點，鏡射 outAtMax」）。
- 刪 `const pad = clip.leadPad ?? 0; const padPx = timeToPx(pad, pps);`；所有用到 `padPx` 的地方改 0：`filmstripTilesFor(... leftPx + placeholderHeadPx + padPx ...)` → `leftPx + placeholderHeadPx`；裁切框 `left: placeholderHeadPx + padPx` → `left: placeholderHeadPx`、`width: contentW - padPx` → `width: contentW`；`contentDur = clip.duration - pad` → `clip.duration`。
- 刪 `{pad > 0 && (<div data-testid="clip-leadpad" ... />)}` 整段與其註解。
- in 把手 `className={'handle in' + (pad > 0 ? ' accent' : '')}` → `className={'handle in' + (inAtMin ? ' danger' : '')}`。

- [ ] **Step 6: Timeline.tsx**

- import：刪 `trimInPad,`，加 `trimIn,`（確認 `dragMath.js` 匯出）與 `isAtSourceMin,`。
- `pending` 型別 `clip-trim` 刪 `leadPad: number`；echo 比對（`:799-803`）改 `return !c || (c.in === pd.in && c.duration === pd.duration);`。
- 刪 `snapExtendedX`（`:866-876`）。
- trim-in 分支（`else { ... }` 從「Plan 12（範圍裁決 2）」註解到 `scheduleFollow(clipStart + placeholder);`）換成：

```ts
      } else {
        // Plan 12（範圍裁決 2）：main-track trim-in 不吸內容座標。
        // 2026-09-11：leadPad 已移除——`trimIn` 在 in=0 硬停（clamp），不再長出黑墊。
        const next = trimIn(clip, deltaSec);
        const dur = next.duration;
        d.preview = { ...clip, in: next.in, duration: dur };
        // Plan 15：修剪方向以頭端佔位撐住足跡，把手＝佔位右緣（placeholder 恆 >= 0）。
        const placeholder = d.origDuration !== undefined ? trimPlaceholder(d.origDuration, dur) : 0;
        setSnapLine(null);
        trimPreviewTarget.current = { clipId: clip.id, in: next.in, placeholderHead: placeholder };
        scheduleFollow(clipStart + placeholder);
```

（後面的捲動補償區塊不動。）

- `inPad`（`:1514-1528`）換成：

```ts
/** 正在拖 in 把手、且已頂到來源起點（in=0）的 clip id——`outAtMaxClipId` 的鏡射。 */
const inAtMinClipId: string | null = (() => {
  const d = drag.current;
  if (!d || d.mode !== 'trim-in') return null;
  return isAtSourceMin(d.preview) ? d.clipId : null;
})();
```

- badge（`:1611-1614`）：`pad: inPad?.clipId === d.clipId ? inPad.pad : undefined,` → `atMin: inAtMinClipId === d.clipId,`。
- `ClipBlock` JSX：`outAtMax={outAtMaxClipId === c.id}` 下一行加 `inAtMin={inAtMinClipId === c.id}`。
- commit 段：刪 `const leadPad = Number((d.preview.leadPad ?? 0).toFixed(3));`；`setPending({ mode: 'clip-trim', clipId: d.clipId, in: inSec, duration })`；`sendCommand` 的 `patch` 只留 `{ in: inSec, duration }`（trim-out 只 `{ duration }` 照舊——開檔對照既有分支）；`setTrimPreview({...})` 刪 `leadPad`。
- 檔內 grep `leadPad` 必須為 0 筆。

- [ ] **Step 7: theme.css——刪 accent 三組規則**

刪 `.clipblk .handle.accent`、`.clipblk .handle.accent:hover`、`.clipblk.selected .handle.accent…`（Task 1 改過的 `::before` 版）及其「Plan 14 Task 4」註解。

- [ ] **Step 8: 全 ui 測試 + typecheck + lint + build**

```bash
cd ui && npx vitest run 2>&1 | tail -6; cd .. && npm run typecheck && npm run lint && npm run build -w @vidcut/ui
grep -rn "leadPad\|trimInPad\|effectivePadFor\|snapExtendedX" ui/src server/src | grep -v "store.ts" ; echo "(只允許 store.ts 的正規化那幾行)"
```

Expected: 全綠；grep 只剩 `server/src/store.ts`。

- [ ] **Step 9: 真瀏覽器：前把手拖到底**

用 `repro-trim.mjs` 改成拖**左**把手往左 400px（`sel.handles[0]`），`during` 時把手 className 含 `danger`，`after` 的 title `in=0.00s`；再看截圖端帽變 `--danger` 色。

- [ ] **Step 10: Commit**

```bash
git add ui/src/timeline/dragMath.ts ui/src/timeline/dragMath.test.ts ui/src/timeline/DragBadge.tsx ui/src/timeline/DragBadge.test.tsx ui/src/timeline/ClipBlock.tsx ui/src/timeline/ClipBlock.test.tsx ui/src/timeline/Timeline.tsx ui/src/timeline/Timeline.trimFollow.test.tsx ui/src/theme.css
git commit -m "feat(ui): 前把手回到來源起點硬停（danger＋· min），拿掉 leadPad 黑墊與 accent 態；Plan 15 佔位保留"
```

---

### Task 8：shared 刪型別與 helper，全套驗證

**Files:**

- Modify: `shared/src/types.ts:99-106`、`:336-340`、`:349`、`:360`
- Modify: `shared/src/timeline.ts:55-74`
- Test: `shared/src/timeline.test.ts:192-225`（刪 describe）

- [ ] **Step 1: 刪 helper 測試（先紅）**

`shared/src/timeline.test.ts`：刪 `describe('clipSourceTime / clipContentDuration（Plan 14 leadPad）'` 整塊。

- [ ] **Step 2: shared**

- `types.ts`：刪 `VideoClip.leadPad?`（含註解）、`TimelineClipSpec.leadPad?`（含註解）、`updateClip` 的 `Pick<... | 'leadPad'>` 改 `Pick<VideoClip, 'in' | 'duration' | 'volume' | 'label'>`、`addClip` 的 `leadPad?: number;`。
- `timeline.ts`：刪 `clipSourceTime`、`clipContentDuration` 與註解。

- [ ] **Step 3: 全套**

```bash
npm run typecheck && npm run lint && npm run format:check
cd shared && npx vitest run; cd ../ui && npx vitest run 2>&1 | tail -4; cd ../server && npx vitest run 2>&1 | tail -6; cd ..
grep -rn "leadPad" shared/src server/src ui/src | grep -v "server/src/store.ts"; echo "(必須空)"
```

Expected: 三 workspace 全綠（server 全套含真 ffmpeg/whisper，約 70–120 秒）。`store.ts` 若用了 `VideoClip & { leadPad?: number }` 交叉型別，typecheck 仍過。

- [ ] **Step 4: Commit**

```bash
git add shared/src/types.ts shared/src/timeline.ts shared/src/timeline.test.ts
git commit -m "refactor(shared): 刪 VideoClip.leadPad 與 clipSourceTime/clipContentDuration——六層移除收尾"
```

---

### Task 9：文件同步、併回 main、推 origin、併進 pro

**Files:**

- Modify: `HANDOFF.md:253-257`（把手段落）、`:474-550`（Plan 14 節）、`:551-598`（Plan 15 節開頭一句）、`:157-159`（顏色段落）
- Modify: `CLAUDE.md`（無新增；確認沒有過期句）

- [ ] **Step 1: HANDOFF.md**

- Plan 14 節標題改成 `## Plan 14：clip 前把手黑墊——leadPad(2026-08-23；**2026-09-11 整組移除**)`，節首加一段：

```
> **2026-09-11 移除**：使用者定案「不要用拖把手加空白時長」。leadPad 六層（型別、命令層、
> MCP、render/frame、播放器、時間軸 UI）全部拿掉；前把手回到 `trimIn` 在 in=0 硬停、把手
> `danger`、badge ` · min`（鏡射 out 把手的 atMax）。舊專案檔的 `leadPad` 由
> `ProjectStore.load` 的 `stripLegacyLeadPad` 一次性清掉（duration 扣墊、刪鍵）。
> 下面的內容保留作歷史脈絡，**不再描述現況**。
```

- Plan 15 節首加一句：「（2026-09-11：leadPad 移除後，本批的佔位機制**保留**；『擴張方向＝還原素材』，不再有『長 leadPad』這個分支。）」
- `:253-257` 把手段落：把「2026-09-10 起視覺改為 `--select-frame` 實心圓角方塊＋`--card` 短刻痕，幾何不變」改成「2026-09-11 起視覺改為 6px 端帽（外圓角同 chip）＋2×14 `--card` 刻痕；**窄片外推已移除**，選取恆 -6」。
- `:157-159`：「主軌 clip 選中例外…實心圓角方塊把手」改成「…2px 外框＋6px 端帽把手同吃 `--select-frame`」。

- [ ] **Step 2: 併回 main、推 origin**

```bash
git add HANDOFF.md && git commit -m "docs(handoff): 記 leadPad 移除、端帽把手與窄片不外推"
cd /Users/maohua/Desktop/gi_+repo/ai-video-cut
git merge --ff-only handle-caps || git merge --no-ff handle-caps -m "merge: handle-caps——端帽把手、窄片不外推、leadPad 六層移除"
npm run build -w @vidcut/ui      # 讓 :3845 反映新 UI
T=$(gh auth token --user mao-data) && git -c credential.helper= -c "credential.helper=!f(){ echo username=mao-data; echo password=$T; }; f" push origin main
```

- [ ] **Step 3: 併進 pro（cloud-upload worktree）**

```bash
cd .claude/worktrees/cloud-upload
git merge main            # 衝突就照「開源側較新且 Pro 有同樣程式碼」原則解；Pro 專屬檔不動
npm run typecheck && (cd ui && npx vitest run 2>&1 | tail -3) && (cd server && npx vitest run test/mcp-surface-snapshot.test.ts test/commands 2>&1 | tail -3)
T=$(gh auth token --user mao-data) && git -c credential.helper= -c "credential.helper=!f(){ echo username=mao-data; echo password=$T; }; f" push pro cloud-upload:main
```

⚠️ Pro 的 `server/src/toolRegistry.ts`（不是 `mcp.ts`）持有工具描述——若 Pro 側的 leadPad 描述住在那裡，合併後要在 Pro 側再刪一次並 `-u` 更新 Pro 的 snapshot；Pro 的 `preflight_check`／ripple 若讀 `leadPad`，grep 後一併清掉。

- [ ] **Step 4: 收 worktree**

```bash
cd /Users/maohua/Desktop/gi_+repo/ai-video-cut && git worktree remove .claude/worktrees/handle-caps && git branch -d handle-caps
```

---

## 自我審查

- **Spec 覆蓋**：方案 1 視覺→Task 1；四種 chip→Task 1（共用 `.handle` 規則＋8 個 JSX 站點加 class）；窄片不外推→Task 1；leadPad 六層→Task 2（命令）、3（render/frame）、4（MCP）、6（播放器）、7（UI）、8（型別/helper）；舊檔清理→Task 5；硬停＋danger＋` · min`→Task 7；Plan 15 保留→Task 7 明文不動 `trimPlaceholder`／`placeholderHead`／`placeholderTail`。
- **型別一致**：`inAtMin`（ClipBlock prop）／`inAtMinClipId`（Timeline）／`isAtSourceMin`（dragMath）／`atMin`（DragBadge）四個名字在 Task 7 內一致；`TrimPreview` 形狀由 Task 6 定義、Task 7 消費。
- **Task 順序保證 typecheck 綠**：型別最後刪（Task 8）；Task 2–7 只拿掉讀寫，optional 欄位仍在型別上。
