// spec §3 資料模型的逐字落地。時間單位一律秒（浮點）。
// JSON-safe：不得出現 Infinity/undefined（overlay 的「到片尾」用 duration: null 表示）。

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
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

export interface OverlayItem {
  id: string;
  imagePath: string;
  /** 錨定片段（與 start 二選一）：片段被拖動時 overlay 跟著走 */
  anchor?: { clipId: string; offset: number };
  /** 絕對時間（與 anchor 二選一） */
  start?: number;
  /** null = 到片尾（JSON 不能存 Infinity） */
  duration: number | null;
  /** x,y 為 0–1 相對畫布；scale 為倍率 */
  position: { x: number; y: number; scale: number };
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  stroke?: string;
  /** 垂直位置 0–1（直式短片以此為主） */
  y: number;
}

export interface CaptionItem {
  id: string;
  text: string;
  start: number;
  duration: number;
  style: CaptionStyle;
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
      patch: Partial<Pick<OverlayItem, 'start' | 'duration' | 'position'>>;
    }
  | {
      name: 'updateCaption';
      id: string;
      patch: Partial<Pick<CaptionItem, 'text' | 'start' | 'duration' | 'style'>>;
    }
  | { name: 'setOverlays'; overlays: OverlayItem[] }
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
  | { name: 'undo'; steps?: number };

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
  | { type: 'commandError'; reqId?: string; error: string };

export type WsClientMsg =
  | { type: 'resync' }
  | { type: 'command'; cmd: Command; reqId?: string }
  | { type: 'context'; context: EditorContextData }
  | { type: 'reviewResolve'; id: string; outcome: ReviewOutcome; note?: string }
  | { type: 'render'; stamp?: string };

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
