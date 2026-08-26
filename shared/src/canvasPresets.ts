// 畫布比例 preset 表。純資料 + 純函數,不碰任何既有程式碼路徑
// (呼叫端接線是後續任務的事)。
//
// 與字幕 preset(pro 限定的 shared/src/captionPresets.ts)同一紀律:
// **專案檔存的是展開後的具體 width/height,不存 preset id**。findCanvasPreset
// 只用來「反查顯示用」(例如 UI 要把某個 preset chip 亮回來),不是專案的儲存格式。
// 日後調整某個 preset 的數值,不會靜默改掉既有專案的畫布尺寸。
//
// ⚠️ width/height 一律偶數:h264 編碼器不接受奇數尺寸的畫面,奇數 preset 會在
// render 階段才炸掉(晚到 export 才發現的錯誤,成本比在這裡守住高很多)。

/** 單一畫布比例 preset。id 是型別聯集,讓呼叫端有型別保護,不必用裸字串比對。 */
export interface CanvasPreset {
  id: 'portrait' | 'landscape' | 'square' | 'portrait-4-5';
  width: number;
  height: number;
  /** UI 顯示用的英文標籤(i18n 閘門擋中文字串字面值,不能寫繁中)。 */
  label: string;
}

/**
 * 四檔畫布比例 preset,陣列順序即 UI 顯示順序。
 *
 * `portrait`(1080×1920)是現狀行為的錨點,必須是陣列第一筆——它是這個編輯器
 * 從一開始就寫死的直式畫布尺寸,多比例支援上線後仍是預設值。
 */
export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: 'portrait', width: 1080, height: 1920, label: 'Portrait 9:16' },
  { id: 'landscape', width: 1920, height: 1080, label: 'Landscape 16:9' },
  { id: 'square', width: 1080, height: 1080, label: 'Square 1:1' },
  { id: 'portrait-4-5', width: 1080, height: 1350, label: 'Portrait 4:5' },
];

/**
 * 用畫布的實際 width/height 反查對應的 preset。
 *
 * ⚠️ 比尺寸,不比名字——專案檔沒有存 preset id,只有展開後的 width/height。
 * 找不到對應 preset(自訂尺寸,或未來 preset 表已變動)時回傳 `undefined`,
 * 呼叫端要自行處理「畫布尺寸不屬於任何已知 preset」的情況。
 */
export function findCanvasPreset(width: number, height: number): CanvasPreset | undefined {
  return CANVAS_PRESETS.find((p) => p.width === width && p.height === height);
}
