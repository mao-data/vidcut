# 字幕／音訊／overlay 拖曳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 三軌 chips 可拖曳平移（吸附）、字幕/音訊左右緣 trim、錨定 overlay 改 offset。

**Architecture:** 純函式（dragMath 擴充）→ 命令層 updateOverlay anchor 互斥規則 → Timeline 的 DragState 擴充 chip 模式（preview + 放手送命令，與主軌同 pattern）。

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-31-track-item-drag-design.md`
- MIN_CLIP_DURATION（0.1s）沿用為字幕/音訊最短長度
- 不碰主軌拖曳、播放引擎

### Task 1: 命令層 updateOverlay anchor（TDD）

**Files:** Modify `shared/src/types.ts`（updateOverlay patch 加 anchor）、`server/src/commands.ts`、`server/src/mcp.ts`（若有 update_overlay 工具則同步 schema）；Test `server/test/commands.test.ts` 追加

**Interfaces:** `{ name: 'updateOverlay'; id; patch: Partial<Pick<OverlayItem, 'start' | 'duration' | 'position' | 'anchor'>> }`；規則：start→刪 anchor、anchor→驗證 clipId＋刪 start

- [x] 測試紅 → 實作 → 綠 → commit

### Task 2: dragMath 擴充（TDD）

**Files:** Modify `ui/src/timeline/dragMath.ts` + `dragMath.test.ts`

**Interfaces:**

```ts
export function shiftStart(start: number, deltaSec: number): number; // max(0, start+delta)
export function trimSpanIn(item: { start: number; duration: number }, deltaSec: number):
  { start: number; duration: number }; // 右緣不動，duration>=MIN、start>=0
export function trimSpanOut(item: { duration: number }, deltaSec: number, maxDuration?: number):
  { duration: number }; // >=MIN、<=maxDuration（省略=無上限）
export function trimAudioIn(a: { start: number; in: number; duration: number }, deltaSec: number):
  { start: number; in: number; duration: number }; // 右緣不動、in>=0、start>=0、duration>=MIN
```
（音訊右緣＝`trimSpanOut(a, delta, mediaDur - a.in)`）

- [x] 測試紅 → 實作 → 綠 → commit

### Task 3: Timeline 互動

**Files:** Modify `ui/src/timeline/Timeline.tsx`

- [x] DragState 加 `{ mode:'chip-move'|'chip-trim-in'|'chip-trim-out'; kind:'caption'|'audio'|'overlay'; id; startX; preview }`
- [x] 三軌 chips：pointerdown 選取＋啟動 chip-move（pointer capture）；字幕/音訊 chip 左右 6px handle 啟動 trim；overlay 錨定式以目前絕對位置換算新 offset
- [x] onPointerMove：算 delta → 純函式 → `maybeSnap` 吸附被拖的邊 → preview；onPointerUp 送 `updateCaption`/`updateAudio`/`updateOverlay`
- [x] 渲染時以 preview 覆蓋顯示（同主軌 trimmedClips pattern）
- [x] 驗證（全測試/typecheck/lint/build/截圖）→ commit
