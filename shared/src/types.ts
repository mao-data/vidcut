// spec §3 資料模型的逐字落地。時間單位一律秒（浮點）。
// JSON-safe：不得出現 Infinity/undefined（overlay 的「到片尾」用 duration: null 表示）。

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
  /** false = 純音訊素材（只能上音訊軌）。舊檔缺此欄 = 有視訊。 */
  hasVideo?: boolean;
  /** 音訊聲道數。渲染據此對 mono 顯式升 stereo（amix 隱式升混會 −3dB）。舊檔可能缺。 */
  audioChannels?: number;
}

export interface MediaAsset {
  id: string;
  /** 原始檔，相對專案資料夾 */
  path: string;
  proxyPath?: string;
  filmstripPath?: string;
  /**
   * filmstrip sprite 實際格數（ffmpeg tile=Nx1 的 N，見 `filmstripPlan`）。
   * 長片會被 JPEG 65500px 上限夾住、格數 < ceil(duration)（降頻取樣，非逐秒一格）。
   * 缺席 = 舊資產（本欄位加入之前 ingest 的）= 每秒一格，換算時以 1 秒/格回退。
   */
  filmstripTiles?: number;
  peaksPath?: string;
  probe: ProbeInfo;
  label?: string;
  /** AI 自由欄位（來源 URL、觀看數、outlier 倍率…） */
  meta?: Record<string, unknown>;
}

/** peaks.json 的形狀（ingest 產出、UI 波形繪製消費）。rms 舊檔沒有 → 繪製退回單層。 */
export interface PeaksFile {
  sampleRate: number;
  samplesPerBucket: number;
  /** 每桶 max|amp|，0–1 */
  peaks: number[];
  /** 每桶 RMS，0–1（2026-07-30 起新 ingest 才有） */
  rms?: number[];
}

export interface VideoClip {
  id: string;
  mediaId: string;
  /** 來源內起點（秒，= 舊腳本 ss） */
  in: number;
  /** 片段長度（秒，= 舊腳本 t） */
  duration: number;
  label?: string;
  /** 0–2，預設 1 */
  volume: number;
  /** 定格幀：畫面凍結在 in 這一刻，持續 duration（渲染時抽單幀成靜圖） */
  frozen?: boolean;
  /** 峰值來源 audio|motion、rank 等 */
  meta?: Record<string, unknown>;
}

/** 文字 overlay 的規格：伺服器據此產卡（見 textOverlays.ts），文字可編輯。 */
export interface OverlayText {
  text: string;
  fontFamily: string;
  fontSize: number;
  fill: string;
  stroke?: string;
  /**
   * 自動換行寬度，0–1 相對畫布寬，預設 0.9。**真的生效**（2026-08-04 起；
   * 在那之前它是死欄位，`text_card.py` 只在帶 tokens 的 karaoke 路徑用它，
   * 文字 overlay 走 `text.split('\n')` 完全不換行，長字直接被畫布邊緣裁掉）。
   *
   * 換行規則（實作在 `server/scripts/text_card.py` 的 `wrap_text()`）：
   * - 可用寬 = `width - cardMargin(width, maxWidth) * 2`（`server/src/rasterizer.ts`，
   *   預覽與匯出兩條路徑共用同一個換算）。
   * - CJK 逐字斷；拉丁/數字整個單字為單位，不會切進單字中間；
   *   換行點上的空白丟掉；行首禁則標點（。，」）…）會黏回前一行。
   * - 文字裡真的 `\n` 一律強制換行（原本唯一的行為，沒有變）。
   * - 單一不可斷字串（超長網址、maxWidth 調到極小）比可用寬還長時**逐字硬切**
   *   （等同 CSS `break-word`），不會溢出被裁掉，也不會無窮迴圈。
   *
   * 卡片寬度仍固定＝畫布寬（多的行只讓卡片變高）。改這個值會改變快取 key **也會**
   * 改變像素——舊卡變孤兒，是預期的。
   */
  maxWidth?: number;
}

export interface OverlayItem {
  id: string;
  /** 文字 overlay 時 = 伺服器產物，勿手動指定（由 resolveTextCommand 依 text 產生並寫入） */
  imagePath: string;
  /** 錨定片段（與 start 二選一）：片段被拖動時 overlay 跟著走 */
  anchor?: { clipId: string; offset: number };
  /** 絕對時間（與 anchor 二選一） */
  start?: number;
  /** null = 到片尾（JSON 不能存 Infinity） */
  duration: number | null;
  /**
   * 相對畫布；scale 為倍率。**語意不對稱**：x 是圖片水平中心、y 是圖片上緣
   * （預覽 translate(-50%, 0)、渲染 x=(W*x)-(w/2), y=H*y 一致）。
   * 滿版直式圖用 {x:0.5, y:0}；y:0.5 是「上緣壓在畫面正中」，不是置中。
   *
   * **不限定 0–1**：元素可以部分掛在畫布外（2026-08-04 起四邊都可以）。y 為負值＝
   * 掛在上緣外，超出的部分被裁掉——預覽靠 stage 的 `overflow: hidden`、渲染靠 ffmpeg
   * `overlay` 對負座標的裁切，兩者行為一致（實測 200px 高的圖 y=-0.05 只露下面 104px）。
   * UI 拖曳的夾制規則是「**元素中心必須留在畫布內**」（見 ui/src/player/dragLayer.ts 的
   * clampCentre），也就是每邊最多露出一半；MCP／命令層不夾制範圍，可以設更極端的值
   * （只驗**有限性**——NaN/Infinity/null 會被 commands.ts 的 numericError 擋下，
   * 那是為了不讓一次壞掉的寫入永久留在專案檔裡；scale 另外限 0–10，見該處註解）。
   * scale 繞「上緣中點」縮放（x/y 錨點不動）：預覽是 CSS transform，渲染是 overlay 前的
   * `scale=iw*s:ih*s`（overlay 的 w 因此是縮放後的寬，置中式子不用改）。
   * 2026-08-04 之前渲染端**沒有實作 scale**，改它只有預覽會變——已修，見 verify:wysiwyg。
   */
  position: { x: number; y: number; scale: number };
  /** 有值 = 文字 overlay（可編輯文字），imagePath 由伺服器維護；無值 = 預烤 PNG（外部腳本產生，文字不可編輯） */
  text?: OverlayText;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  stroke?: string;
  /** 垂直位置 0–1（直式短片以此為主） */
  y: number;
  /** 逐詞高亮色：已唸到的詞用這色（僅在 caption 有 tokens 時生效） */
  highlight?: string;
}

/**
 * 逐詞時間戳。時間為**時間軸絕對秒數**（與 CaptionItem.start 同座標），
 * 不是相對 caption 起點——省掉每次讀取都要加減 start 的機會錯誤。
 */
export interface CaptionToken {
  text: string;
  start: number;
  end: number;
}

export interface CaptionItem {
  id: string;
  text: string;
  start: number;
  duration: number;
  style: CaptionStyle;
  /** 有值時預覽與渲染都做逐詞 karaoke 高亮（渲染改走 PNG 字卡，見 render.ts） */
  tokens?: CaptionToken[];
}

export interface AudioItem {
  id: string;
  mediaId: string;
  /** 絕對時間 */
  start: number;
  in: number;
  duration: number;
  volume: number;
  /** 淡入秒數 */
  fadeIn?: number;
  /** 淡出秒數 */
  fadeOut?: number;
  /** 播放期間把影片主軌音量壓低（固定比例，見 render.ts DUCK_LEVEL） */
  ducking?: boolean;
  /** 用途標記，UI 顯示用（旁白 / BGM…） */
  label?: string;
}

export interface ReviewState {
  id: string;
  /** AI 對這輪工作的說明（顯示在審核條） */
  summary: string;
  /** 要高亮的 clipId */
  focus?: string[];
  /** 這輪 AI 工作的起始 version（退回時的回滾範圍、核准時的 feedback 範圍） */
  sinceVersion: number;
  requestedAt: string;
}

export interface RenderState {
  lastOutput?: string;
  status: 'idle' | 'running' | 'done' | 'error';
  progress?: number;
  error?: string;
  /** 封面圖（相對專案資料夾） */
  coverPath?: string;
}

/**
 * 字幕在成品裡的處理方式。
 * - `burn`（預設）：燒進畫面，關不掉——維持本欄位存在前的行為。
 * - `off`：完全不放字幕。
 * - `sidecar`：畫面乾淨，另外產一個同名 `.srt` 放在 `output/`。
 * - `embed`：畫面乾淨，字幕以 soft track 內嵌進 mp4（`mov_text`），播放器可自行開關。
 *
 * `off`/`sidecar`/`embed` 都**不燒**——soft track 若同時燒錄，觀眾開字幕會看到兩排字。
 */
export type SubtitleExportMode = 'burn' | 'off' | 'sidecar' | 'embed';

/** 匯出設定。省略時用專案畫布尺寸與預設品質。 */
export interface RenderOptions {
  /** 字幕處理方式，預設 `burn`。 */
  subtitles?: SubtitleExportMode;
  /** 輸出短邊寬（等比縮放整個合成結果），例：720 / 1080 */
  width?: number;
  height?: number;
  fps?: number;
  /** 品質模式：crf 越小越好（預設 20） */
  crf?: number;
  /** 指定位元率（如 '10M'）時改用位元率模式 */
  videoBitrate?: string;
  codec?: 'h264' | 'hevc';
}

export interface ProjectTracks {
  video: VideoClip[];
  overlays: OverlayItem[];
  captions: CaptionItem[];
  audio: AudioItem[];
}

/** 素材未填滿畫布時的填充方式：contain = 黑邊；blur = 模糊放大填充（9:16 標配） */
export type CanvasFit = 'contain' | 'blur';

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  canvas: { width: number; height: number; fps: number; fit?: CanvasFit };
  media: MediaAsset[];
  tracks: ProjectTracks;
  /** 當前待審核請求（見 spec §6）；resolve 後置回 null */
  review: ReviewState | null;
  render: RenderState;
}

/**
 * `setTimeline` 的輸入單元。`id` 省略時由命令層生成（nanoid）。
 *
 * **為什麼 id 是可選的、而且省略時不再用「索引＋mediaId」推導**：舊的
 * `clip_${索引}_${mediaId}` 是決定性的，重排之後同一個名字仍然存在、卻已經是**另一個
 * 片段**了——錨在它上面的 overlay 不會變孤兒（那還看得出來），而是靜靜地跑到別的時間點。
 * 實測同素材同順序重送一次 set_timeline：4 個 overlay 有 2 個的 anchor 指向不存在的
 * clip，第 3 個的 anchor 名字還在但指到了後面一格。
 * 要讓錨點活下來，就**明確帶上原本的 id**——這才是有意義的「同一個片段」。
 */
export interface TimelineClipSpec {
  /** 省略＝這是一個新片段，命令層給新 id；帶上既有 id ＝沿用，錨定的 overlay 因此不斷。 */
  id?: string;
  mediaId: string;
  in: number;
  duration: number;
  label?: string;
  volume?: number;
  meta?: Record<string, unknown>;
}

// ---- 命令層（人類 UI 與 MCP 工具共用的唯一寫入語意來源）----
export type Command =
  | {
      name: 'updateClip';
      clipId: string;
      patch: Partial<Pick<VideoClip, 'in' | 'duration' | 'volume' | 'label'>>;
    }
  | { name: 'reorderClips'; order: string[] }
  | { name: 'removeClip'; clipId: string }
  /** 新增一段畫面到主軌尾端（人從素材庫加入；AI 通常用 set_timeline 整組排） */
  | { name: 'addClip'; mediaId: string; in: number; duration: number; label?: string }
  /**
   * 整組替換影片主軌（初次排片）。以前這是 MCP 工具**自己 store.mutate** 的，是唯一
   * 繞過命令層的編輯——因此也繞過了 numericError，而 WS 那條路根本用不到它。
   */
  | { name: 'setTimeline'; clips: TimelineClipSpec[] }
  | {
      name: 'updateOverlay';
      id: string;
      /** start 與 anchor 互斥：給 start 會清 anchor（轉絕對）、給 anchor 會清 start（轉錨定） */
      patch: Partial<
        Pick<OverlayItem, 'start' | 'duration' | 'position' | 'anchor' | 'text' | 'imagePath'>
      >;
    }
  | {
      name: 'updateCaption';
      id: string;
      /** tokens 給空陣列＝清除逐詞時間戳（JSON 無法傳 undefined，需要可序列化的「清除」） */
      patch: Partial<Pick<CaptionItem, 'text' | 'start' | 'duration' | 'style' | 'tokens'>>;
    }
  | { name: 'setOverlays'; overlays: OverlayItem[] }
  /** 新增單張疊圖（人從 UI 上傳；AI 通常用 setOverlays 整組排） */
  | { name: 'addOverlay'; overlay: OverlayItem }
  | { name: 'removeOverlay'; id: string }
  | { name: 'setCaptions'; captions: CaptionItem[] }
  /** 在時間軸絕對時間切開該處片段（playhead 分割） */
  | { name: 'splitAt'; time: number }
  /** 刪除 time 之前的所有畫面（磁性主軌自動閉合） */
  | { name: 'deleteBefore'; time: number }
  /** 刪除 time 之後的所有畫面 */
  | { name: 'deleteAfter'; time: number }
  /** 在 time 處插入一段定格幀 */
  | { name: 'freezeFrame'; time: number; duration?: number }
  /** 把片段的聲音抽成獨立音訊項（片段本身靜音），可單獨編輯 */
  | { name: 'extractAudio'; clipId: string }
  | {
      name: 'updateAudio';
      id: string;
      patch: Partial<
        Pick<AudioItem, 'start' | 'in' | 'duration' | 'volume' | 'fadeIn' | 'fadeOut' | 'ducking'>
      >;
    }
  | { name: 'removeAudio'; id: string }
  | { name: 'setAudio'; audio: AudioItem[] }
  | { name: 'setCanvasFit'; fit: CanvasFit }
  /**
   * 登記一支已經處理完（proxy/filmstrip/peaks 都產好）的素材。跑 ffmpeg 的 async 前置
   * 留在 `server/src/ingest.ts` 的 `prepareMedia`，命令層只做同步的登記——與文字 overlay
   * 的 `resolveTextCommand` 同一個模式（見 textOverlays.ts）。
   *
   * 走命令層是為了讓 AI 那條路吃得到 `aiWrite` 的審核鎖：以前 import_media 直接
   * `store.mutate`，**審核進行中照樣能把素材塞進專案**（實測素材 11 → 12 筆）。
   * 人的路徑（HTTP 上傳）走 applyCommand，不受審核鎖——那是使用者自己的審核。
   *
   * patch path 是 `media` 不是 `tracks`／`canvas`，所以不進 undo 堆疊（見 store 的 isUndoable）。
   */
  | { name: 'registerMedia'; asset: MediaAsset }
  /** 設定封面圖。抽幀的 async 前置留在 `render.ts` 的 `renderCoverImage`；理由同 registerMedia。 */
  | { name: 'setCover'; path: string }
  | { name: 'undo'; steps?: number }
  | { name: 'redo'; steps?: number };

/**
 * `changed: false` ＝ 命令合法、也真的套用了，但**沒有任何欄位改變**（immer 產生零個
 * patch），所以 version 停在原地。這不是錯誤——送一個跟現值相同的 position 本來就合法
 * ——但呼叫端一定要分得出來：以前這種情形回的是跟真正成功一字不差的 `ok, version=N`，
 * 而 N 沒動；AI 沒有任何辦法知道自己的編輯其實沒生效。
 *
 * 可選欄位（不是必填）：undo/redo 這種不經過 `mutate` 回傳值的路徑就不帶，
 * 現有的呼叫端也不必全部改。只有明確的 `false` 才代表「什麼都沒變」。
 */
export type CommandResult =
  { ok: true; version: number; changed?: boolean } | { ok: false; error: string };

// ---- 審核與編輯脈絡 ----
export type ReviewOutcome = 'approved' | 'rejected' | 'approved_with_notes' | 'timeout';

/** 人在 UI 的當前脈絡（ephemeral，非 project.json 一部分）。get_editor_context 回傳。 */
export interface EditorContextData {
  selection: { kind: 'clip' | 'overlay' | 'caption' | 'audio'; id: string } | null;
  playhead: number;
  range: { start: number; end: number } | null;
}

// ---- WS 協議（spec §4.1）----
// patch 用 immer 的 Patch 形狀（{op, path: (string|number)[], value?}），UI 端 applyPatches 直接可用。
export interface JsonPatch {
  op: 'add' | 'replace' | 'remove';
  path: (string | number)[];
  value?: unknown;
}

export type MutationSource = 'ai' | 'human';

/** 活動記錄 / history 條目的精簡形（廣播與 UI 顯示用）。 */
export interface HistoryBrief {
  version: number;
  label: string;
  source: MutationSource;
  ts: string;
}

// ---- 聊天（人 ⇄ AI 的 meta 溝通渠道）----
/**
 * 一則聊天訊息。**刻意不進 `Project`**：聊天是關於編輯的對話，不是編輯本身，
 * 所以它不走 `applyCommand`、不進 doc、不進版本/歷史/undo（Cmd+Z 不該撤掉一句話）。
 * 持久化在與 `project.json` 同目錄的 `chat.json`，由 `server/src/chatStore.ts` 管。
 */
export interface ChatMessage {
  id: string;
  author: 'user' | 'ai';
  text: string;
  /** ISO 8601 時間戳（`new Date().toISOString()`）。 */
  ts: string;
}

export type WsServerMsg =
  | { type: 'full'; version: number; doc: Project; history: HistoryBrief[] }
  | {
      type: 'patch';
      version: number;
      patches: JsonPatch[];
      source: MutationSource;
      label: string;
      ts: string;
    }
  | { type: 'commandError'; reqId?: string; error: string }
  /** 渲染進度旁路（暫態，不進版本/歷史/undo） */
  | { type: 'renderProgress'; progress: number }
  /** 字幕卡 id→hash 對照（僅字幕；文字 overlay 走 doc.imagePath，不需要對照表） */
  | { type: 'textCards'; entries: Array<{ id: string; hash: string }> }
  /**
   * AI 工具呼叫的進行中訊號（暫態旁路，**不是 Command**：不動 doc、不進版本/歷史/undo）。
   * server 端由 mcp.ts 的 registerTool 包裝層在 handler 進入/離開（含拋錯）時發射，
   * `callId` 是全域遞增序號，start 與其配對的 end 共用同一個值。
   */
  | { type: 'agentActivity'; phase: 'start' | 'end'; tool: string; callId: string }
  /**
   * 整份聊天記錄（連線時送一次，之後每次有新訊息都重送完整清單）。
   * 與 `textCards`／`agentActivity` 同類的旁路：**不動 doc、不進版本/歷史/undo**，
   * 所以它沒有 `version` 欄位，UI 端必須早期 return，別落到 patch 分支去
   * （那會把 `undefined` 版本判成 resync，形成無限迴圈）。
   */
  | { type: 'chat'; messages: ChatMessage[] };

export type WsClientMsg =
  | { type: 'resync' }
  | { type: 'command'; cmd: Command; reqId?: string }
  /**
   * 瀏覽器端的使用者發一則聊天訊息。**不是 `Command`**——它不改專案狀態，
   * 所以不走 `applyCommand`；驗證（空字串、長度上限）在 `wsHub` 的命令層做，不在 UI。
   */
  | { type: 'sendChatMessage'; text: string }
  | { type: 'context'; context: EditorContextData }
  | { type: 'reviewResolve'; id: string; outcome: ReviewOutcome; note?: string }
  | { type: 'render'; stamp?: string; options?: RenderOptions }
  | { type: 'setCover'; time: number };

export function createEmptyProject(id: string, name: string): Project {
  return {
    schemaVersion: 1,
    id,
    name,
    canvas: { width: 1080, height: 1920, fps: 30 },
    media: [],
    tracks: { video: [], overlays: [], captions: [], audio: [] },
    review: null,
    render: { status: 'idle' },
  };
}
