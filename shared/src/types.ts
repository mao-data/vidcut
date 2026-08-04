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
   * 原本的語意是「換行寬 0–1 相對畫布，預設 0.9」，**但目前是死欄位**（2026-08-04 實測）：
   * `text_card.py` 只在 `layout_tokens()` 裡用這個邊界換行，而 `layout_tokens()` 只有帶
   * tokens 時才會跑；`server/src/textOverlays.ts` 從來不給文字 overlay 塞 tokens，所以
   * 文字 overlay 走的是 `text.split('\n')` 那條路——**完全不換行**。
   * 實測：同一段長文字分別給 0.9 與 0.3，產出的 PNG sha256 相同、`lines` 都是 1。
   * 實際後果：長文字不折行，超出的部分直接被畫布邊緣裁掉（字卡寬度固定＝畫布寬）。
   * 這個值目前只會進快取 key（換值會重產一張長得一樣的卡），不影響像素。
   * 真的要換行是之後的工作；在那之前不要拿它當「排版控制項」對外宣傳。
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
   * 0–1 相對畫布；scale 為倍率。**語意不對稱**：x 是圖片水平中心、y 是圖片上緣
   * （預覽 translate(-50%, 0)、渲染 x=(W*x)-(w/2), y=H*y 一致）。
   * 滿版直式圖用 {x:0.5, y:0}；y:0.5 是「上緣壓在畫面正中」，不是置中。
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

/** 匯出設定。省略時用專案畫布尺寸與預設品質。 */
export interface RenderOptions {
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

// ---- 命令層（人類 UI 與 MCP 工具共用的唯一寫入語意來源）----
export type Command =
  | {
      name: 'updateClip';
      clipId: string;
      patch: Partial<Pick<VideoClip, 'in' | 'duration' | 'volume' | 'label'>>;
    }
  | { name: 'reorderClips'; order: string[] }
  | { name: 'removeClip'; clipId: string }
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
  | { name: 'undo'; steps?: number }
  | { name: 'redo'; steps?: number };

export type CommandResult = { ok: true; version: number } | { ok: false; error: string };

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
  | { type: 'textCards'; entries: Array<{ id: string; hash: string }> };

export type WsClientMsg =
  | { type: 'resync' }
  | { type: 'command'; cmd: Command; reqId?: string }
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
