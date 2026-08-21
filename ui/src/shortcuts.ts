/**
 * 快捷鍵顯示表：Inspector 的 ShortcutHelp 彈出層由這張表生成，不要再硬編一份文字。
 *
 * **這張表描述的是 `App.tsx` 那顆 `onKey` handler 的實況**（外加時間軸的 Ctrl+wheel
 * 縮放，那條在 `timeline/Timeline.tsx` 的 wheel listener，不走 keydown）。
 * 它是**說明文字**，不是行為來源——handler 的 `switch` 沒有引用這裡的字串，
 * 因為那顆 handler 是經過測試驗證的控制流，硬要拿常數當 case 條件只會讓它更難讀。
 * 代價就是這張表得靠人維護：**改了 `App.tsx` 的 onKey，必須同步改這裡**（反之亦然）。
 *
 * 平台字眼沿用既有慣例：修飾鍵一律寫 `Cmd`（handler 實際上 `metaKey || ctrlKey` 都收），
 * 不做平台偵測。
 */
export type Shortcut = {
  /** 顯示用的按鍵字串，例如 `Cmd+B`。 */
  keys: string;
  /** 顯示用的動作說明。 */
  label: string;
};

/** 依「播放 → 剪輯 → 檢視 → 歷史」大致分組，順序即彈出層的顯示順序。 */
export const SHORTCUTS: readonly Shortcut[] = [
  // 播放／導覽
  { keys: 'Space', label: 'Play/Pause' },
  { keys: '←/→', label: 'Frame step' },
  { keys: 'Shift+←/→', label: '10 frames' },
  // 剪輯
  { keys: 'S', label: 'Split' },
  { keys: 'Cmd+B', label: 'Split' },
  { keys: 'Q', label: 'Delete left' },
  { keys: 'W', label: 'Delete right' },
  { keys: 'F', label: 'Freeze' },
  // Plan 11 Task 3（裁決 6）：只動選取項本身，跟 Q/W（ripple 刪除、動全時間軸）
  // 語意不同——標籤刻意寫「Trim selection」而非「Trim」，避免使用者誤以為跟 Q/W
  // 一樣是全時間軸操作。
  { keys: '[', label: 'Trim selection in to playhead' },
  { keys: ']', label: 'Trim selection out to playhead' },
  // 檢視
  { keys: 'Esc', label: 'Deselect' },
  { keys: 'N', label: 'Snap' },
  { keys: 'Shift+Z', label: 'Fit' },
  { keys: 'Ctrl+wheel', label: 'Zoom' },
  // 歷史
  { keys: 'Cmd+Z', label: 'Undo' },
  { keys: 'Cmd+Shift+Z', label: 'Redo' },
] as const;
