// server/src/cardSync.ts — 字幕變更後重產字卡並通知 UI。debounce 吸收連續命令(拖時間軸、批量刪句)。
import type { CaptionItem } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';

export function capToCardRequest(cap: CaptionItem, canvasWidth: number): CardRequest {
  return {
    text: cap.text,
    ...(cap.tokens?.length ? { tokens: cap.tokens.map((t) => t.text) } : {}),
    style: {
      fontFamily: cap.style.fontFamily,
      fontSize: cap.style.fontSize,
      fill: cap.style.fill,
      ...(cap.style.stroke ? { stroke: cap.style.stroke } : {}),
      ...(cap.style.highlight ? { highlight: cap.style.highlight } : {}),
    },
    width: canvasWidth,
  };
}

export class CaptionCardSync {
  latest: Array<{ id: string; hash: string }> = [];
  onReady?: (entries: Array<{ id: string; hash: string }>) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private store: ProjectStore,
    private svc: TextCardService,
    private debounceMs = 300,
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow().catch((e: unknown) => {
        console.warn('caption card sync failed:', (e as Error).message);
      });
    }, this.debounceMs);
  }

  async runNow(): Promise<Array<{ id: string; hash: string }>> {
    if (this.running) {
      this.schedule(); // 正在跑就改排下一輪(取最新 doc)
      return this.latest;
    }
    this.running = true;
    try {
      const doc = this.store.doc;
      const entries: Array<{ id: string; hash: string }> = [];
      for (const cap of doc.tracks.captions) {
        const r = await this.svc.ensure(capToCardRequest(cap, doc.canvas.width));
        entries.push({ id: cap.id, hash: r.hash });
      }
      this.latest = entries;
      this.onReady?.(entries);
      return entries;
    } finally {
      this.running = false;
    }
  }
}
