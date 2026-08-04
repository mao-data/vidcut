import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 這個套件裡有 9 個測試檔會 spawn 真的 ffmpeg，而單支 ffmpeg 的 x264 編碼
    // 預設就開滿核心數的執行緒——檔案層再平行等於把 CPU 超訂數倍，實測峰值
    // 7 支 ffmpeg 併發、load 16.8（8 核機器）。後果不是等比例變慢而是爆炸性的
    // （記憶體頻寬飽和 + 快取互相驅逐 + 上下文切換），最重的整合測試曾被餓到
    // 958 秒、撞破自己 180 秒的 wall-clock timeout。
    //
    // 關掉檔案平行幾乎不虧：ffmpeg 本來就吃滿所有核心，循序跑 CPU 依然滿載。
    // 實測全套 32 秒（平行）→ 51 秒（循序），換到的是決定性。
    fileParallelism: false,
  },
});
