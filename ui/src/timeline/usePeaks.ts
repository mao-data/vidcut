import { useEffect, useState } from 'react';
import type { PeaksFile } from '@vidcut/shared';

/** 存 Promise 而非結果：冷載入時多個片段共用同一媒體，第一個 fetch 發起就佔位，其餘 await 同一份 */
const peaksCache = new Map<string, Promise<PeaksFile>>();

/**
 * 測試專用：清掉模組級快取，避免不同測試檔（或同一檔的不同 case）用同一個 peaksPath
 * 卻互相污染——這個 cache 是模組級單例，fixtures 的 demo 專案固定用 `derived/m2/peaks.json`，
 * 不同測試對同一個 URL 的 fetch 結果會互相殘留（一支測試的成功 peaks 會讓後跑的「404 不畫波形」
 * 測試看到快取命中而非真的 fetch，2026-08-20 隨機順序跑法抓到）。
 */
export function __resetPeaksCacheForTests(): void {
  peaksCache.clear();
}

export function useWaveform(peaksPath: string | undefined): PeaksFile | null {
  const [peaks, setPeaks] = useState<PeaksFile | null>(null);
  useEffect(() => {
    if (!peaksPath) return;
    const url = `/media/${peaksPath}`;
    let promise = peaksCache.get(url);
    if (!promise) {
      promise = fetch(url).then((r) => r.json() as Promise<PeaksFile>);
      peaksCache.set(url, promise);
      // 失敗就移除佔位，之後 mount 的組件才會重試
      promise.catch(() => peaksCache.delete(url));
    }
    let alive = true;
    promise.then((j) => alive && setPeaks(j)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [peaksPath]);
  return peaks;
}
