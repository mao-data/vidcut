import { useEffect, useState } from 'react';
import type { PeaksFile } from '@vidcut/shared';

/** 存 Promise 而非結果：冷載入時多個片段共用同一媒體，第一個 fetch 發起就佔位，其餘 await 同一份 */
const peaksCache = new Map<string, Promise<PeaksFile>>();

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
