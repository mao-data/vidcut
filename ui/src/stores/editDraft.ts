// ui/src/stores/editDraft.ts — 三段式即時改字的中段狀態：本地打字的草稿 + 其預覽卡 hash。
// 只有這個 store 在打字期間變動；不進 history、不碰 project doc、不經 sendCommand。
import { create } from 'zustand';

interface DraftCaption {
  id: string;
  text: string;
  /** 該 text 對應的預覽卡 hash；text 一變就清成 null,直到 debounce 後的 /text-card/preview 回應到位 */
  previewHash: string | null;
}
export interface EditDraftState {
  caption: DraftCaption | null;
  setText: (id: string, text: string) => void;
  setPreview: (id: string, hash: string) => void;
  clear: () => void;
}

export const useEditDraft = create<EditDraftState>((set, get) => ({
  caption: null,
  setText: (id, text) => set({ caption: { id, text, previewHash: null } }),
  setPreview: (id, hash) => {
    const cur = get().caption;
    // 只在 id 仍是當前 draft 時收——呼叫端(CaptionList)另外還會比對 text,
    // 擋掉「同句改兩次字、舊那次回應較晚抵達」的情況(id 相同但內容已經過期)。
    if (cur?.id === id) set({ caption: { ...cur, previewHash: hash } });
  },
  clear: () => set({ caption: null }),
}));
