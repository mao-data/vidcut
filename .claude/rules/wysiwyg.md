---
paths:
  [
    "server/src/render.ts",
    "server/src/rasterizer.ts",
    "server/src/textCards.ts",
    "server/src/textOverlays.ts",
    "server/src/cardBudget.ts",
    "server/src/fonts.ts",
    "server/scripts/text_card.py",
    "ui/src/player/**",
    "shared/src/subtitles.ts",
  ]
---

# 「預覽即成品」的實際範圍與字卡管線

`caption-wysiwyg` 的招牌宣稱是「預覽看到的就是成品」。**非 karaoke 字幕與 overlay
（含文字 overlay）都成立**（2026-08-04 起）；karaoke 字幕仍是已知的、可重現的不一致
——但**偏差在預覽端，匯出成品是正確的**。

**自動化守門：`npm run verify:wysiwyg`**（`ui/e2e/preview-vs-export.mjs`）真的 render
一支影片、抽幀量墨跡外框，再用 headless Chromium 截同一時刻的預覽、換算回 1080×1920
座標比對。**現在六項全綠（最大差 1.1px，容差 4）**——任何一項轉紅都是真的回歸，先看
`measure/` 裡的 PNG，不要動斷言。
⚠️ **它證明的是「兩邊一致」，不是「兩邊都對」**：有些回歸兩邊會一起壞（文字 overlay 的
預覽與成品吃同一張 PNG；渲染端夾了負座標而預覽端也夾了），那時比對照樣全綠。所以有幾個
case 另外釘住**成品側**的墨跡形狀（`exportInk`）——換行那項釘「高 ≥ 2 行、寬 ≤ 可用寬」、
掛畫布外那項釘「上緣貼齊 y0=0 且被裁短」、水平不置中那項釘「左緣 ≤ 120」。加新 case 時
想一下你的缺陷會不會兩邊一起壞，會的話就要補 `exportInk`。

## 各類元素的狀態

- ✅ **字幕(無逐詞高亮)**：預覽與匯出走同一支 `text_card.py`、同一份參數，輸出 PNG
  **逐位元組相同**（sha256 相等）。實測涵蓋超寬文字、內嵌換行、未知字型、非 1080 畫布寬。
- ✅ **overlay（含文字 overlay）**（2026-08-04 修好）：曾有兩個互相疊加的成因——
  (a) 預覽端 `Player.tsx` 給 overlay `<img>` 設 `maxWidth: 1080 * 0.9`，`render.ts` 卻以
  原生尺寸合成（成品每次比預覽大 ≈11%）；(b) `position.scale` 只有預覽端吃（CSS
  transform），渲染端濾鏡鏈上沒有任何 scale，而 Inspector 有使用者改得動的 scale 欄位。
  修法是兩邊都往「正確」收斂：渲染端在 overlay 前插 `scale=iw*s:ih*s`（`overlay` 的 `w`
  讀縮放後的寬，`x=(W*x)-(w/2)` 置中式不用改），預覽端拿掉 0.9 夾制、保留 CSS scale。
  ⚠️ `scale <= 0`／NaN 的 overlay **整張不合成**：ffmpeg 的 `scale=0` 意思是「沿用原尺寸」，
  照原樣疊上去等於重新製造「預覽看不見、成品有一張全尺寸圖」的靜默落差。
- ✅ **掛在畫布外的 overlay**（拖曳夾制改成「中心留在畫布內」後 `position.y` 可為負）：
  預覽靠 stage 的 `overflow: hidden` 裁、成品靠 ffmpeg `overlay` 吃負座標裁，同一條線。
  `verify:wysiwyg` 的 `ov_offtop` case 守著。⚠️ **不要把這個 case 改成擺在角落**：stage 有
  `borderRadius: 10`，預覽圓角、成品方角，換算回畫布座標約 17px（大於容差 4）——角落
  墨跡會因這個純視覺差異被判紅，是假警報。所以那一項水平置中，只驗上緣。
- ✅ **水平定位**（`ov_offcentre`，x=0.25）：在這之前每個 case 的 x 都是 0.5 且墨跡左右
  對稱——實測把渲染端 x 映射整個鏡射（`x → 1-x`）五項照樣全綠，即當時只驗了垂直幾何。
  補上之後同一個鏡射突變會當場失敗。
- ⚠️ **karaoke 字幕**：預覽是「base 卡 + 全高亮卡疊 `clip-path`」，匯出是「一詞一卡」，
  不是同一張圖。成因：(a) 描邊補償 `pad`（`max(2, fontSize/16)`）會把下一個還沒唸到的詞
  露出約 4px 高亮色；(b) 兩層 alpha 疊合讓描邊反鋸齒邊變厚。
  **結論先講，免得下一個人跑去修不存在的 bug：匯出那條路是正確的**（一詞一卡＝單層，
  每個字直接用自己的顏色畫）。偏差在**預覽**，症狀是描邊看起來略厚，成品沒問題。
  卡片層級實測（4 詞 CJK、64px、1080×92 卡）：高亮 1–4 詞時不同像素 772–2227
  （0.78%–2.24%），最大單通道差 104–165。差異散佈在整段已高亮文字的描邊反鋸齒邊緣，
  成因 (b) 是主要貢獻者。
  ⚠️ **重測時合成模型不能用 PIL 的 `paste(mask=)`**——那是線性內插（取代），瀏覽器兩張
  `<img>` 疊起來是 source-over（alpha 累積）。用 paste 會得到 10–19 像素的假結果，正好把
  成因 (b) 抹掉。正確做法：hl 的 alpha 乘上 clip 遮罩後 `Image.alpha_composite(base, clipped)`。

## 已拆除的地雷

- **原生 `drawtext` 分支 2026-08-05 整條刪掉**。那條路沒有 `fontfile=`、不換行、描邊寫死
  3px，是完全不同的光柵器；本機 ffmpeg 沒編 freetype 永遠踩不到，但換一台有的機器
  「預覽=成品」會靜默失效。現在 burn 模式只有 Pillow 字卡一條路，沒有字卡就是不燒字；
  `render.test.ts` 有測試釘死它不准回來。
- **字型降級收緊**：`fonts.ts` 與 `text_card.py` 的候選清單以前只有 macOS 路徑，Linux/CI
  必然全滅 → 掉進 Pillow 內建點陣字型（無 CJK）且兩邊吃同一張壞卡、全綠靜默。現在兩份
  清單補了 Linux/Windows 路徑；python 回報 `fontFallback`；**匯出直接失敗**（字幕燒進去
  就拿不掉了），啟動時印警告。

## 自動換行（2026-08-04；`OverlayText.maxWidth` 從死欄位變成真的生效）

在這之前 `maxWidth` 是死欄位：`text_card.py` 只在 `layout_tokens()` 用它折行，而那條只有
帶 `tokens`（karaoke）才跑——**文字 overlay 與字幕都不換行，太長直接被畫布裁掉且無警告**。

現在無 tokens 路徑也會折行（`wrap_text()`）：

- 可用寬 = `width - cardMargin(width, maxWidthFrac) * 2`；`cardMargin()` 在
  `server/src/rasterizer.ts`，是**唯一**換算來源。預覽（rasterizer worker）與匯出
  （`render.ts` 自己 spawn 的 CLI）都得用它——匯出端以前不傳 `margin`、靠 python 預設
  `max(32, width // 20)`，那兩式只在畫布寬 ≥ 640 時同值，小畫布一折行就分岔。
- **CJK 逐字折、拉丁以單字為單位**、換行點空白丟掉、行首禁則標點（。，」）…）黏回前一行；
  真的 `\n` 仍強制換行。單一不可斷字串比可用寬長 → 逐字硬切（等同 CSS `break-word`）。
- ⚠️ **`cardBudget.ts` 的行數估算是「每字元各佔一行」的上界**。Node 側沒有字型量測只能取
  上界——代價是很長的文字會被誤拒（1080 寬、fontSize 64 上限約 146 字）。這個上界在
  「可用寬只放得下一個字」時會被真的打到（`textCards.test.ts` 釘住等號），不是保險係數。
- ⚠️ 副作用（預期內）：已存專案裡被裁掉的長文字現在會折行 → 字卡變高、hash 改變
  （內容定址，舊 PNG 變孤兒檔）。
- 回歸守門：`verify:wysiwyg` 的 `ov_wrap` case + `server/test/rasterizer.test.ts`
  （折行點 ≡ 手打 `\n` 的 PNG 位元組相同）。文字 overlay 預覽與成品吃同一張 PNG，
  兩邊比對本身抓不到「換行沒實作」——那一項另外釘了成品側墨跡形狀。

## 幾何 schema 演進

`ink` 是後加的欄位，而字卡是內容定址的（同輸入→同 key→命中舊 `.json`）。
`TextCardService.ensure` 把「缺 `ink` 的 .json」當快取未命中重畫（同 hash 原地覆寫，PNG
位元組不變）——**幾何 schema 之後再長新欄位，記得一起加進那個檢查**，否則既有專案永遠
拿不到它。用這條而不是把 `rasterizerId` 往上加：加號碼會讓每張卡改名、既有 `imagePath`
全部要靠遷移追。
