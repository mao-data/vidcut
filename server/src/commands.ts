import { nanoid } from 'nanoid';
import type {
  AudioItem,
  Command,
  CommandResult,
  MutationSource,
  OverlayItem,
  CaptionItem,
  VideoClip,
} from '@vidcut/shared';
import { totalDuration } from '@vidcut/shared';
import type { ProjectStore } from './store.js';

const MIN_CLIP_DURATION = 0.1;
const DEFAULT_FREEZE_DURATION = 3;

/** 主軌是磁性的：片段起點 = 前面所有片段長度累加。 */
function startsOf(clips: VideoClip[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const c of clips) {
    out.push(t);
    t += c.duration;
  }
  return out;
}

/** 找出時間軸絕對時間落在哪個片段，回傳索引與片段內偏移。 */
function clipAt(
  clips: VideoClip[],
  time: number,
): { index: number; offset: number; start: number } | null {
  if (time < 0) return null;
  const starts = startsOf(clips);
  for (let i = clips.length - 1; i >= 0; i--) {
    if (time >= starts[i]!) return { index: i, offset: time - starts[i]!, start: starts[i]! };
  }
  return null;
}

/**
 * 人類 UI 與 MCP 工具共用的唯一寫入語意來源（OpenChatCut EditorCore 模式）。
 * 每個命令先驗證，通過才 store.mutate。失敗回 {ok:false,error}，絕不靜默。
 */
export function applyCommand(
  store: ProjectStore,
  source: MutationSource,
  cmd: Command,
): CommandResult {
  switch (cmd.name) {
    case 'updateClip':
      return updateClip(store, source, cmd);
    case 'reorderClips':
      return reorderClips(store, source, cmd);
    case 'removeClip':
      return removeClip(store, source, cmd);
    case 'updateOverlay':
      return updateOverlay(store, source, cmd);
    case 'addOverlay':
      return addOverlay(store, source, cmd);
    case 'removeOverlay': {
      if (!store.doc.tracks.overlays.some((o) => o.id === cmd.id)) {
        return { ok: false, error: `overlay not found: ${cmd.id}` };
      }
      return ok(
        store.mutate(source, 'remove overlay', (d) => {
          d.tracks.overlays = d.tracks.overlays.filter((o) => o.id !== cmd.id);
        }),
      );
    }
    case 'updateCaption':
      return updateCaption(store, source, cmd);
    case 'setOverlays':
      return ok(
        store.mutate(source, 'set overlays', (d) => {
          d.tracks.overlays = cmd.overlays as OverlayItem[];
        }),
      );
    case 'setCaptions':
      return ok(
        store.mutate(source, 'set captions', (d) => {
          d.tracks.captions = cmd.captions as CaptionItem[];
        }),
      );
    case 'splitAt':
      return splitAt(store, source, cmd.time);
    case 'deleteBefore':
      return deleteSide(store, source, cmd.time, 'before');
    case 'deleteAfter':
      return deleteSide(store, source, cmd.time, 'after');
    case 'freezeFrame':
      return freezeFrame(store, source, cmd.time, cmd.duration ?? DEFAULT_FREEZE_DURATION);
    case 'extractAudio':
      return extractAudio(store, source, cmd.clipId);
    case 'updateAudio':
      return updateAudio(store, source, cmd);
    case 'removeAudio': {
      if (!store.doc.tracks.audio.some((a) => a.id === cmd.id)) {
        return { ok: false, error: `audio not found: ${cmd.id}` };
      }
      return ok(
        store.mutate(source, 'remove audio', (d) => {
          d.tracks.audio = d.tracks.audio.filter((a) => a.id !== cmd.id);
        }),
      );
    }
    case 'setAudio':
      return ok(
        store.mutate(source, 'set audio', (d) => {
          d.tracks.audio = cmd.audio as AudioItem[];
        }),
      );
    case 'setCanvasFit':
      return ok(
        store.mutate(source, `canvas fit: ${cmd.fit}`, (d) => {
          d.canvas.fit = cmd.fit;
        }),
      );
    case 'undo': {
      const r = store.undo(source, cmd.steps ?? 1);
      return r ? { ok: true, version: r.version } : { ok: false, error: 'nothing to undo' };
    }
    case 'redo': {
      const r = store.redo(source, cmd.steps ?? 1);
      return r ? { ok: true, version: r.version } : { ok: false, error: 'nothing to redo' };
    }
    default: {
      const _exhaustive: never = cmd;
      return { ok: false, error: `unknown command: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

function ok(r: { version: number }): CommandResult {
  return { ok: true, version: r.version };
}

function updateClip(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateClip' }>,
): CommandResult {
  const clip = store.doc.tracks.video.find((c) => c.id === cmd.clipId);
  if (!clip) return { ok: false, error: `clip not found: ${cmd.clipId}` };
  const media = store.doc.media.find((m) => m.id === clip.mediaId);
  const srcDur = media?.probe.duration ?? Infinity;

  const nextIn = cmd.patch.in ?? clip.in;
  const nextDur = cmd.patch.duration ?? clip.duration;
  if (nextIn < 0) return { ok: false, error: 'in must be >= 0' };
  if (nextDur < MIN_CLIP_DURATION)
    return { ok: false, error: `duration must be >= ${MIN_CLIP_DURATION}` };
  if (nextIn + nextDur > srcDur + 1e-6) {
    return { ok: false, error: `in+duration (${nextIn + nextDur}) exceeds source ${srcDur}` };
  }
  if (cmd.patch.volume !== undefined && (cmd.patch.volume < 0 || cmd.patch.volume > 2)) {
    return { ok: false, error: 'volume must be within 0..2' };
  }

  return ok(
    store.mutate(source, `edit ${clip.label ?? clip.id}`, (d) => {
      const c = d.tracks.video.find((x) => x.id === cmd.clipId)!;
      if (cmd.patch.in !== undefined) c.in = cmd.patch.in;
      if (cmd.patch.duration !== undefined) c.duration = cmd.patch.duration;
      if (cmd.patch.volume !== undefined) c.volume = cmd.patch.volume;
      if (cmd.patch.label !== undefined) c.label = cmd.patch.label;
    }),
  );
}

function reorderClips(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'reorderClips' }>,
): CommandResult {
  const current = store.doc.tracks.video.map((c) => c.id);
  if (
    cmd.order.length !== current.length ||
    new Set(cmd.order).size !== cmd.order.length ||
    !cmd.order.every((id) => current.includes(id))
  ) {
    return { ok: false, error: 'order must be a permutation of existing clip ids' };
  }
  return ok(
    store.mutate(source, 'reorder clips', (d) => {
      const byId = new Map(d.tracks.video.map((c) => [c.id, c]));
      d.tracks.video = cmd.order.map((id) => byId.get(id)!);
    }),
  );
}

function removeClip(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'removeClip' }>,
): CommandResult {
  if (!store.doc.tracks.video.some((c) => c.id === cmd.clipId)) {
    return { ok: false, error: `clip not found: ${cmd.clipId}` };
  }
  return ok(
    store.mutate(source, `remove ${cmd.clipId}`, (d) => {
      d.tracks.video = d.tracks.video.filter((c) => c.id !== cmd.clipId);
    }),
  );
}

function addOverlay(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'addOverlay' }>,
): CommandResult {
  const o = cmd.overlay;
  if (store.doc.tracks.overlays.some((x) => x.id === o.id)) {
    return { ok: false, error: `overlay id already exists: ${o.id}` };
  }
  if (o.duration !== null && o.duration <= 0) {
    return { ok: false, error: 'overlay duration must be > 0 or null' };
  }
  if (o.anchor === undefined && o.start === undefined) {
    return { ok: false, error: 'overlay needs start or anchor' };
  }
  if (o.anchor && !store.doc.tracks.video.some((c) => c.id === o.anchor!.clipId)) {
    return { ok: false, error: `anchor clip not found: ${o.anchor.clipId}` };
  }
  if (o.text) {
    if (o.text.text.trim() === '') return { ok: false, error: 'overlay text must not be empty' };
    if (o.text.fontSize <= 0) return { ok: false, error: 'fontSize must be > 0' };
    if (o.imagePath === '') return { ok: false, error: 'text overlay card not generated (server error)' };
  }
  return ok(
    store.mutate(source, `add overlay ${o.imagePath.split('/').pop()}`, (d) => {
      d.tracks.overlays.push(o);
    }),
  );
}

function updateOverlay(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateOverlay' }>,
): CommandResult {
  if (!store.doc.tracks.overlays.some((o) => o.id === cmd.id)) {
    return { ok: false, error: `overlay not found: ${cmd.id}` };
  }
  if (cmd.patch.duration !== undefined && cmd.patch.duration !== null && cmd.patch.duration <= 0) {
    return { ok: false, error: 'overlay duration must be > 0 or null' };
  }
  if (cmd.patch.anchor !== undefined) {
    if (!store.doc.tracks.video.some((c) => c.id === cmd.patch.anchor!.clipId)) {
      return { ok: false, error: `anchor clip not found: ${cmd.patch.anchor.clipId}` };
    }
    if (cmd.patch.start !== undefined) {
      return { ok: false, error: 'start and anchor are mutually exclusive' };
    }
  }
  if (cmd.patch.text) {
    if (cmd.patch.text.text.trim() === '') return { ok: false, error: 'overlay text must not be empty' };
    if (cmd.patch.text.fontSize <= 0) return { ok: false, error: 'fontSize must be > 0' };
    if (cmd.patch.imagePath === '') {
      return { ok: false, error: 'text overlay card not generated (server error)' };
    }
  }
  return ok(
    store.mutate(source, `edit overlay`, (d) => {
      const o = d.tracks.overlays.find((x) => x.id === cmd.id)!;
      // start／anchor 互斥：兩種定位不能同時存在（overlayWindow 會偏袒 anchor，
      // 留著會出現「設了 start 看似成功實際無效」的隱性陷阱）
      if (cmd.patch.start !== undefined) {
        o.start = cmd.patch.start;
        delete o.anchor;
      }
      if (cmd.patch.anchor !== undefined) {
        o.anchor = cmd.patch.anchor;
        delete o.start;
      }
      if (cmd.patch.duration !== undefined) o.duration = cmd.patch.duration;
      if (cmd.patch.position !== undefined) o.position = cmd.patch.position;
      if (cmd.patch.text !== undefined) o.text = cmd.patch.text;
      if (cmd.patch.imagePath !== undefined) o.imagePath = cmd.patch.imagePath;
    }),
  );
}

function updateCaption(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateCaption' }>,
): CommandResult {
  if (!store.doc.tracks.captions.some((c) => c.id === cmd.id)) {
    return { ok: false, error: `caption not found: ${cmd.id}` };
  }
  if (cmd.patch.duration !== undefined && cmd.patch.duration <= 0) {
    return { ok: false, error: 'caption duration must be > 0' };
  }
  return ok(
    store.mutate(source, `edit caption`, (d) => {
      const c = d.tracks.captions.find((x) => x.id === cmd.id)!;
      if (cmd.patch.text !== undefined) c.text = cmd.patch.text;
      if (cmd.patch.start !== undefined) c.start = cmd.patch.start;
      if (cmd.patch.duration !== undefined) c.duration = cmd.patch.duration;
      if (cmd.patch.style !== undefined) c.style = cmd.patch.style;
      if (cmd.patch.tokens !== undefined) {
        // 空陣列＝清除逐詞時間戳。JSON 傳不了 undefined（鍵會整個消失），
        // 所以「清除」必須有一個能被序列化的表示法。
        if (cmd.patch.tokens.length === 0) delete c.tokens;
        else c.tokens = cmd.patch.tokens;
      }
    }),
  );
}

/** 在時間軸絕對時間切開片段（playhead 分割）。切點須嚴格落在片段內部。 */
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
      const second: VideoClip = {
        ...c,
        id: nanoid(6),
        in: c.in + left,
        duration: right,
      };
      c.duration = left;
      d.tracks.video.splice(hit.index + 1, 0, second);
    }),
  );
}

/**
 * 刪除 playhead 一側的畫面（CapCut 的 Q / W）。磁性主軌自動閉合。
 * 只影響影片主軌；overlay/字幕/音訊不動（與 CapCut 同語意）。
 */
function deleteSide(
  store: ProjectStore,
  source: MutationSource,
  time: number,
  side: 'before' | 'after',
): CommandResult {
  const clips = store.doc.tracks.video;
  const total = totalDuration(store.doc);
  if (clips.length === 0) return { ok: false, error: 'timeline is empty' };
  if (side === 'before' && time <= 0) return { ok: false, error: 'nothing before 0' };
  if (side === 'after' && time >= total) return { ok: false, error: 'nothing after the end' };
  if (side === 'before' && time >= total) return { ok: false, error: 'would delete everything' };
  if (side === 'after' && time <= 0) return { ok: false, error: 'would delete everything' };

  const starts = startsOf(clips);
  const kept: VideoClip[] = [];
  clips.forEach((c, i) => {
    const s = starts[i]!;
    const e = s + c.duration;
    if (side === 'before') {
      if (e <= time) return; // 整段在左側 → 丟掉
      if (s < time) {
        const cut = time - s; // 片段被切掉的前半
        const rest = c.duration - cut;
        if (rest < MIN_CLIP_DURATION) return;
        kept.push({ ...c, in: c.in + cut, duration: rest });
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
  if (kept.length === 0) return { ok: false, error: 'would delete everything' };
  return ok(
    store.mutate(
      source,
      side === 'before' ? 'delete before playhead' : 'delete after playhead',
      (d) => {
        d.tracks.video = kept;
      },
    ),
  );
}

/** 在 time 處插入一段定格幀（畫面凍結，渲染時抽單幀成靜圖）。 */
function freezeFrame(
  store: ProjectStore,
  source: MutationSource,
  time: number,
  duration: number,
): CommandResult {
  if (duration < MIN_CLIP_DURATION) return { ok: false, error: 'freeze duration too short' };
  const clips = store.doc.tracks.video;
  const hit = clipAt(clips, time);
  if (!hit) return { ok: false, error: `no clip at ${time}s` };
  const clip = clips[hit.index]!;
  const atSource = clip.in + hit.offset; // 要凍結的來源時間點

  return ok(
    store.mutate(source, `freeze frame @${time.toFixed(2)}s`, (d) => {
      const frozen: VideoClip = {
        id: nanoid(6),
        mediaId: clip.mediaId,
        in: atSource,
        duration,
        volume: 0, // 定格段無聲
        frozen: true,
        label: `❄ ${clip.label ?? clip.id}`,
      };
      const c = d.tracks.video[hit.index]!;
      if (hit.offset < MIN_CLIP_DURATION) {
        // 貼在片段開頭 → 直接插在它前面，不切
        d.tracks.video.splice(hit.index, 0, frozen);
      } else if (clip.duration - hit.offset < MIN_CLIP_DURATION) {
        // 貼在片段結尾 → 插在它後面
        d.tracks.video.splice(hit.index + 1, 0, frozen);
      } else {
        // 中間 → 切成兩段，定格插在中間
        const second: VideoClip = {
          ...clip,
          id: nanoid(6),
          in: clip.in + hit.offset,
          duration: clip.duration - hit.offset,
        };
        c.duration = hit.offset;
        d.tracks.video.splice(hit.index + 1, 0, frozen, second);
      }
    }),
  );
}

/**
 * 把片段的聲音抽成獨立音訊項（片段轉靜音），之後可單獨調音量/淡化/刪除。
 * 音訊項用絕對時間，抽出後不跟隨片段搬動（與 CapCut 同語意）。
 */
function extractAudio(store: ProjectStore, source: MutationSource, clipId: string): CommandResult {
  const clips = store.doc.tracks.video;
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return { ok: false, error: `clip not found: ${clipId}` };
  const clip = clips[index]!;
  const media = store.doc.media.find((m) => m.id === clip.mediaId);
  if (!media) return { ok: false, error: `media not found: ${clip.mediaId}` };
  if (!media.probe.hasAudio) return { ok: false, error: 'clip has no audio to extract' };
  const start = startsOf(clips)[index]!;

  return ok(
    store.mutate(source, `extract audio from ${clip.label ?? clip.id}`, (d) => {
      d.tracks.audio.push({
        id: nanoid(6),
        mediaId: clip.mediaId,
        start,
        in: clip.in,
        duration: clip.duration,
        volume: clip.volume || 1,
        label: `🔊 ${clip.label ?? clip.id}`,
      });
      d.tracks.video[index]!.volume = 0;
    }),
  );
}

function updateAudio(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateAudio' }>,
): CommandResult {
  const item = store.doc.tracks.audio.find((a) => a.id === cmd.id);
  if (!item) return { ok: false, error: `audio not found: ${cmd.id}` };
  const media = store.doc.media.find((m) => m.id === item.mediaId);
  const nextIn = cmd.patch.in ?? item.in;
  const nextDur = cmd.patch.duration ?? item.duration;
  if (nextIn < 0) return { ok: false, error: 'in must be >= 0' };
  if (nextDur <= 0) return { ok: false, error: 'duration must be > 0' };
  if (media && nextIn + nextDur > media.probe.duration + 1e-6) {
    return { ok: false, error: `in+duration exceeds source ${media.probe.duration}` };
  }
  if (cmd.patch.start !== undefined && cmd.patch.start < 0) {
    return { ok: false, error: 'start must be >= 0' };
  }
  if (cmd.patch.volume !== undefined && (cmd.patch.volume < 0 || cmd.patch.volume > 2)) {
    return { ok: false, error: 'volume must be within 0..2' };
  }
  for (const k of ['fadeIn', 'fadeOut'] as const) {
    const v = cmd.patch[k];
    if (v !== undefined && (v < 0 || v > nextDur)) {
      return { ok: false, error: `${k} must be within 0..duration` };
    }
  }
  return ok(
    store.mutate(source, `edit audio ${item.label ?? item.id}`, (d) => {
      Object.assign(
        d.tracks.audio.find((a) => a.id === cmd.id)!,
        cmd.patch,
      );
    }),
  );
}
