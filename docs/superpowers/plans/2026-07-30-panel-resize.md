# 面板拖曳伸縮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 左右面板可拖曳調寬（含 <140px 自動收合、雙擊回預設、localStorage 記憶）。

**Architecture:** 純函式 `resolvePanelDrag` 決策（可測）→ view store 持狀態（含 localStorage）→ `PanelResizer` 元件掛在中欄左右緣 → App grid 讀 store 寬度、拖曳中關過渡。

**Tech Stack:** React 19、zustand v5（注意：selector 不得回傳新 reference）、純 CSS。

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-30-panel-resize-design.md`
- 常數：左 min 200 / max 420 / 預設 260；右 min 240 / max 500 / 預設 320；收合門檻 140
- 現有 143 測試全綠；typecheck/lint/build 乾淨

### Task 1: 純函式 + view store

**Files:** Create `ui/src/panelResize.ts`、Test `ui/src/panelResize.test.ts`、Modify `ui/src/stores/view.ts`

**Interfaces:**

```ts
export type PanelSide = 'left' | 'right';
export const PANEL = {
  left: { min: 200, max: 420, default: 260 },
  right: { min: 240, max: 500, default: 320 },
  collapseBelow: 140,
} as const;
/** rawPx = 由游標推得的目標寬。回 open:false 表示應收合（width 維持原值不動）。 */
export function resolvePanelDrag(side: PanelSide, rawPx: number): { open: boolean; width?: number };
```

- [x] Step 1: 測試（clamp 上下限、<140 收合、140–min 之間夾到 min、正常區間原值）
- [x] Step 2: 實作 + view store 加 `leftWidth/rightWidth/setPanelWidth(side, w)/openPanel(side, open)`，初始化讀 localStorage（key `vidcut.panelWidths`），setter 寫回
- [x] Step 3: 測試綠、commit

### Task 2: PanelResizer + App 接線

**Files:** Create `ui/src/PanelResizer.tsx`、Modify `ui/src/App.tsx`、`ui/src/theme.css`

- [x] Step 1: `PanelResizer({ side, containerRef, onResizingChange })`：pointerdown capture → move 算 rawPx（left: `e.clientX - rect.left`；right: `rect.right - e.clientX`）→ `resolvePanelDrag` → 寫 store；雙擊回預設；`.resizer` class（6px、hover ::after 紫線）
- [x] Step 2: App：`gridRef`；中欄 `position:relative` 掛兩個 resizer；grid 欄寬 `leftOpen ? leftWidth : 0`；`resizing` state 時 transition 'none'；內層固定寬改讀 store
- [x] Step 3: typecheck/lint/build/截圖無迴歸、commit
