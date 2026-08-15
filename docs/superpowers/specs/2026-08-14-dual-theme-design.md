# 雙世界雙主題——暗房調和+分鏡紙桌面(設計定案)

日期:2026-08-14 · 狀態:**設計定案**(使用者核准方向 A 與 mock,對照頁
`themes.html` 於 scratchpad,未入庫)
前情:`docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md`(現行深色
系統)、`2026-08-14-agent-presence-design.md`(紙世界大使館)。

## 0. 決策變更記錄

07-30 spec 將「淺色主題」列為明確不做(「深色工具的定位明確」)。
**使用者於 2026-08-14 明確推翻此條**:編輯器做亮/暗雙主題。本檔取代該條;
07-30 spec 的其餘定案(骨架、不引 Tailwind 等)不受影響。

## 1. 診斷(為什麼要調)

- `--bg: #0d0e16` 亮度僅 ~2%,近純黑且偏冷;專業剪輯工具的底慣例在 10–18%。
- **亮度斷層**:底 2% → surface(白 5–8% 透明度,近黑上層差微弱)→ 直接跳
  50% 亮度的飽和紫 `#8b5cf6`,中間無階梯——「按鈕很亮很怪」的本質。
- 三個溫度並存:冷藍黑底、亮紫/青雙強調、大使館暖米紙——無統一環境光。
- 工程紅利:Tier 0 後顏色已收斂為 35 token+18 處殘餘硬編;canvas(waveform/
  filmstrip)為 JS 常數,CSS 變數進不去。

## 2. 主題 A:暗房調和(階段 ①)

原則:**調和,不重造**。紫世界身分不變,補亮度樓梯、收溫度。

| token              | 現值      | 新值      | 說明                                                                                  |
| ------------------ | --------- | --------- | ------------------------------------------------------------------------------------- |
| `--bg`             | `#0d0e16` | `#15161d` | 底提到 ~10%,微暖灰;**只有預覽 stage 周圍維持最暗**(見下)                              |
| `--panel`(新)      | —         | `#191a22` | header、左右面板、時間軸區的實底——樓梯第二階                                          |
| `--popover-bg`     | `#1a1d2e` | `#242530` | 浮出層在 panel 之上再一階                                                             |
| `--surface`        | 白 5%     | 白 6%     | 在較亮的底上維持既有層感                                                              |
| `--accent`         | `#8b5cf6` | `#6d5bd0` | 降飽和——主行動鈕不再螢光;`--accent-text`/`--accent-bright`(深底上的文字/圖形亮紫)不動 |
| `--clip-frozen-bg` | `#2d3a52` | `#2c2f42` | 收冷藍偏向,與新底同溫                                                                 |

- **stage 例外規則**:預覽影片直接鄰接的區域用 `--bg-stage: #101117`(比
  `--bg` 暗)——淺色環境干擾影片顏色判斷,stage 永遠是房間裡最暗處。
- 18 處殘餘硬編色全部收進 token(主題基建的前置,本階段順手完成)。
- **大使館紙條配合調整**(前輪診斷的 V3,使用者已閱):膠帶收進紙內
  (外懸 ≤2px)、著地陰影改冷黑 `rgba(0,0,0,.55)`(Ink Shadow 規則管紙上
  物件;暗房裡的桌影本來就黑)、紙條底改 `--ap-paper-dim: #ede8dc`
  (DESIGN.md 的「Paper」階;索引卡未來仍用 `--ap-paper`)。
- 對比驗收:`--text-1/2/3` 對 `--panel` 與 `--bg` 全組合重算 WCAG,語意文字
  ≥4.5:1(`--text-3` 維持僅限裝飾的既有限定)。

## 3. 主題 B:分鏡紙桌面(階段 ③,方向定案、細節屆時走 craft)

紙世界(`site/DESIGN.md`)接管亮版,不是暗版翻白:

- 底:`#ede8dc` 24px 點格紙;面板:`#f7f3e9` 紙卡+ink 陰影;文字:ink/graphite 階。
- **紅鉛筆只做筆的工作**:playhead、時間碼進行值、字幕 chip 描邊、focus、
  手寫註記。絕不當底色(Two-Hands/One-Pigment 全套沿用)。
- 波形:non-photo blue 刻度式;時間軸片段:ink 描邊紙卡(filmstrip 在卡內)。
- **stage 暗襯底規則(硬性)**:亮版下預覽影片周圍仍為中性深色襯底
  (「貼在紙上的深色相紙」),理由同上——色彩判斷優先於世界觀。
- 大使館元素在亮版下天然融入(同一張紙桌)。

> **階段 ③ 實作定案(2026-08-14 修訂,以實作為準)**:
>
> - **波形維持包絡渲染,只換 non-photo blue 色**——「刻度式」是 canvas 渲染行為
>   變更(會動到暗版共用的 drawWaveform),不在主題階段範圍,要做另開案。
> - **主行動鈕=ink 實體**(`--accent: #26231d`+紙白字 14.14:1),非 mock 的描邊款
>   ——紫在紙上全面退場(One-Pigment),grep 驗證無殘留。
> - **吸附導線 `--warn` 維持琥珀**:它畫在 stage 的影片上,不在紙上——stage
>   例外規則的延伸(紙色導線在影片上會隱形)。
> - **點格紙印在面板上,不是 body**:編輯器骨架蓋滿 viewport,body 的格紙永遠
>   看不見(截圖抓到的,computed value 驗不出這種問題)。
> - **`.seg.on` 用墨不用紅**:分頁選中是 UI 狀態不是批註,紅框會讀成「紅色系
>   UI 強調」= Two-Hands 違規(實作中途自我修正)。
> - **署名分色開專屬 token `--who-ai`/`--who-you`**(Inspector+Activity 共用):
>   暗版值=既有紫/藍字面值(computed 不變);紙版 **AI=graphite、you=紅鉛筆**
>   ——紅是批註、是人的手(agent-presence spec 的 Two-Hands 分色條)。首版把
>   AI 映到紅,主 session 審查時抓到反了,已修正。
> - `::selection` 用 DESIGN.md 的 highlighter(`--hl`,編輯器首次啟用);光暈族
>   在紙上一律改 ink 投影(紙不發光,選取=紙卡抬起)。

> **階段 ③ craft 補強(2026-08-14 第二輪修訂——使用者反饋「主題感不夠明顯」後
> 三批補強,以實作為準)**:
>
> - **字體接管**:paper 下 UI 字體切 Jost(DESIGN.md body font)。@font-face 由
>   `500 600` 放寬為 `400 700`(fvar 實測軸 100–900);單一宣告點(body,其餘
>   `font: inherit`);中文 fallback 鏈保留(Jost 零 CJK 字形);mono 讀數與字卡
>   管線不碰。暗版唯一 Jost 消費者 `.ap-cap` 固定 600,放寬前後選同一 instance。
> - **材質層**:header 分界 2px ink 實線;結構性分隔改 `1.5px dashed`(App.tsx
>   三條 inline 分界收編為 `.panel-edge-*` class,暗版值逐字元相同);**資料列
>   `.rowline` 維持實線**(密集列間 dashed 是噪音);微旋轉只給桌上物件
>   (empty-note −0.7deg/toast +0.5deg/Export −0.3deg),**stage/video/時間軸/
>   popover/資料列絕不轉**——前兩者是座標量測面(overlay 拖曳、verify:canvas
>   的 transform 檢查),後者是可讀性;focus-visible 改 red pencil dashed;
>   hover=物理輕推不加大陰影。
> - **手寫層**:Caveat 500/700 入庫(兩檔 byte-identical——Google css2 對
>   variable font 回同一 URL;OFL 授權檔同入)。只給「介面對你說話」的文字:
>   empty-note 16px/hint 14px(等效係數 1.3,headless canvas x-height 實測);
>   **資料絕不手寫**(字幕/時間碼/檔名/工具名/快捷鍵表,後兩者需主動擋回
>   mono/Jost——快捷鍵手寫會按錯)。新 `--font-ui` token 供逃逸 Caveat 繼承。
> - **使用者第二輪收回(2026-08-14 定案,最高優先)**:看過成品後,(a) **Caveat
>   手寫體從 app 文字全面退場**(引導句/hint 回 Jost;字型檔+@font-face 保留給
>   階段 4 索引卡再議);(b) **分隔線一律 1px 實線**(dashed 撤回,兩主題);
>   (c) **UI 元件一律擺正**(empty-note/toast/Export/hover 的 rotate 全撤,focus
>   虛線改實線)。原則:「app 跟 landing 不一樣」——虛線/傾斜/手寫是 landing 的
>   表現語彙,工作介面要乾淨可掃讀。**保留**:Jost 字體(兩主題)、hover 物理
>   輕推(translate,無 rotate)、AgentStrip 大使館形態(微轉+膠帶+offline 虛線
>   圈,使用者逐輪核准的識別,不在收回範圍)、disabled 欄位的虛線框(功能性
>   提示,非分隔線)。
> - **playhead 鉛筆濾鏡:試裝後否決**。feDisplacementMap 對 2px 細線是「啃」
>   不是「抖」(1× DPR 全不可見、2× DPR 線寬 3–5px 跳動+圓頭壓扁),且
>   playhead 逐幀改 `left` 是播放熱路徑,濾鏡逐幀重算。長筆畫(.ap-frame/
>   .ap-ring)才吃得起這濾鏡。否決結論註記在 Timeline.tsx 防重試。

## 4. 主題基建(階段 ②,行為零變、預設視覺零變)

- token 雙值化:`:root` 為暗版預設,`[data-theme='paper']` 覆寫;JS 讀
  `localStorage.vidcutTheme`,無值時跟 `prefers-color-scheme`(dark→暗房,
  light→紙)。
- canvas 查表:waveform/filmstrip 的 JS 顏色常數改為 theme-aware lookup,
  切換時觸發重繪(沿用既有的重繪路徑,不新造)。
- 切換器 UI:位置與形式屆時定(候選:header 或 Shortcuts 彈出層旁),
  `aria-pressed`/label 齊備。
- 驗收:預設(暗)下全部 verify 腳本與截圖 diff 零變化——基建不許改任何像素。

> **階段 ② 實作定案(2026-08-14 修訂,以實作為準)**:
>
> - **切換器位置定案:Inspector 的 Shortcuts 彈出層尾端**(`.seg` 鈕、`Paper theme`
>   標籤、`aria-pressed`)。選這裡正是「零視覺變化」的要求使然——彈出層預設關著,
>   主畫面一個像素都不動。階段 ③ 亮版成品後可再議是否升格 header 常駐。
> - **`dark` 不設 `data-theme` 屬性(是移除,不是 `data-theme="dark"`)**——保證預設
>   DOM 與基建前逐位元組相同,這是零變化驗收的機制本身。
> - **canvas 查表走 CSS 變數**:波形五色收進 `:root` 的 `--wave-*` token,
>   `waveform.ts` 於 draw 時 `getComputedStyle` 讀取(jsdom 無樣式表時回退暗版
>   字面值);顏色真值從此只有 theme.css 一份。切換重畫靠 ClipBlock/AudioChip 的
>   draw effect 依賴 theme store 值。
> - **`0.30`→`0.3`**:prettier 強制正規化 CSS alpha 尾零,故 token 寫 `0.3`、JS 回退
>   字面值保留 `0.30`,兩者解析為同一顏色(雙側註解已記)。
> - paper 佔位塊比 §2 列表多蓋了 `--line-strong`(否則紙底上片段描邊繼承暗版白
>   14% 透明會隱形)。佔位品質,階段 ③ 全面重調。

## 5. 工序與驗收

| 階段         | 內容                                                           | 驗收                                                           |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| ① 暗版和諧化 | §2 全部                                                        | 測試全綠+build+verify:panels/canvas+前後截圖+對比重算+gauntlet |
| ② 主題基建   | §4                                                             | 同上,外加「預設視覺零變化」截圖 diff                           |
| ③ 紙桌面亮版 | §3(craft 級)                                                   | 同 ①,外加亮版全景截圖+使用者過目                               |
| ④ 文件       | 編輯器 DESIGN.md 首度落地(documenter)、HANDOFF/EVIDENCE 逐階段 | docs-check;docs-sync-review 流程                               |

反目標:不碰 wysiwyg 管線(字卡是影片世界,與 UI 主題無關)、不動骨架、
不引 CSS 框架;`verify:wysiwyg` 在任何階段都必須不受影響。
