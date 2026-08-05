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
    // 實測牆鐘時間與平行時同一個量級（不同次量測互有勝負，循序甚至可能更快——
    // 平行版的尾巴會被互搶核心拖長），換到的是決定性。這裡刻意不寫死秒數：
    // 它高度依賴機器與當下負載，寫進註解只會過期並誤導。
    fileParallelism: false,

    // 測試暫存目錄的清理，分成兩半：
    // globalSetup 建立這一輪的暫存根目錄，並在所有 worker 結束後整個刪掉；
    // setupFiles 只負責在某個測試檔有失敗時寫下「別清」的標記（保留出事現場）。
    // 少了任何一行，那些目錄就會永遠留在系統 temp——實測一次全套跑留下 147 個。
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],

    // VIDCUT_TMP_FIXTURE=1 時改成只跑 test/_leak/ 底下的假測試檔。
    // tmp-cleanup.test.ts 用子行程帶著這個變數呼叫自己，為的是讓那條檢查跑在
    // **這一份真的設定**上——如果改用另外拼一份 config，就驗不到「setupFiles
    // 有沒有真的接上」，而那正是最容易漏掉的一步。
    ...(process.env.VIDCUT_TMP_FIXTURE ? { include: ['test/_leak/*.fixture.ts'] } : {}),
  },
});
