import type {
  Command,
  CommandResult,
  MutationSource,
  OverlayItem,
  CaptionItem,
} from '@vidcut/shared';
import type { ProjectStore } from './store.js';

const MIN_CLIP_DURATION = 0.1;

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
    case 'undo': {
      const r = store.undo(cmd.steps ?? 1);
      return r ? { ok: true, version: r.version } : { ok: false, error: 'nothing to undo' };
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
  return ok(
    store.mutate(source, `edit overlay`, (d) => {
      const o = d.tracks.overlays.find((x) => x.id === cmd.id)!;
      if (cmd.patch.start !== undefined) o.start = cmd.patch.start;
      if (cmd.patch.duration !== undefined) o.duration = cmd.patch.duration;
      if (cmd.patch.position !== undefined) o.position = cmd.patch.position;
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
    }),
  );
}
