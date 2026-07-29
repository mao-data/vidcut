import { nanoid } from 'nanoid';
import type { HistoryBrief, ReviewOutcome } from '@vidcut/shared';
import type { ProjectStore } from './store.js';

export interface ReviewResult {
  outcome: ReviewOutcome;
  note?: string;
  /** 自 review 開始以來的人類變更（供 AI 讀回調整） */
  humanChanges: HistoryBrief[];
}

interface Pending {
  id: string;
  sinceVersion: number;
  resolve: (r: ReviewResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * request_review 的核心（spec §6）：AI 呼叫 request → 設 doc.review、阻塞等待；
 * 人在 UI 核准/退回 → resolve。退回時回滾該輪 AI 變更（undo 回 sinceVersion）。
 * 逾時回 outcome:'timeout'。
 */
export class ReviewManager {
  #store: ProjectStore;
  #timeoutMs: number;
  #pending: Pending | null = null;

  constructor(store: ProjectStore, timeoutMs = 900_000) {
    this.#store = store;
    this.#timeoutMs = timeoutMs;
  }

  get activeId(): string | null {
    return this.#pending?.id ?? null;
  }

  /** AI 呼叫。回傳的 promise 在人核准/退回/逾時時 resolve。 */
  request(summary: string, focus?: string[]): Promise<ReviewResult> {
    // 一次只允許一個 review：若已有，先以 timeout 收掉舊的
    if (this.#pending) this.#finish(this.#pending.id, 'timeout');

    const id = nanoid(8);
    const sinceVersion = this.#store.version;
    this.#store.mutate('ai', 'request review', (d) => {
      d.review = { id, summary, focus, sinceVersion, requestedAt: new Date().toISOString() };
    });

    return new Promise<ReviewResult>((resolve) => {
      const timer = setTimeout(() => this.#finish(id, 'timeout'), this.#timeoutMs);
      this.#pending = { id, sinceVersion, resolve, timer };
    });
  }

  /** 人在 UI 核准/退回。id 不符或無 pending 回 false。 */
  resolve(id: string, outcome: ReviewOutcome, note?: string): boolean {
    if (!this.#pending || this.#pending.id !== id) return false;
    this.#finish(id, outcome, note);
    return true;
  }

  #finish(id: string, outcome: ReviewOutcome, note?: string): void {
    const p = this.#pending;
    if (!p || p.id !== id) return;
    clearTimeout(p.timer);
    this.#pending = null;

    // 自 review 開始以來的人類變更（審核期間只有 human 能寫）
    const humanChanges: HistoryBrief[] = this.#store
      .history()
      .filter((h) => h.version > p.sinceVersion && h.source === 'human')
      .map((h) => ({ version: h.version, label: h.label, source: h.source, ts: h.ts }));

    // 清 review 狀態
    this.#store.mutate('human', 'close review', (d) => {
      d.review = null;
    });

    // 退回：回滾該輪 AI 變更（undo 回 sinceVersion）
    if (outcome === 'rejected') {
      const steps = this.#store.version - p.sinceVersion;
      if (steps > 0) this.#store.undo(steps);
    }

    p.resolve({ outcome, note, humanChanges });
  }
}
