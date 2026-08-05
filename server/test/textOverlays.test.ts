import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { TextCardService } from '../src/textCards.js';
import {
  resolveTextCommand,
  refreshTextOverlayCards,
  overlayTextToCardRequest,
} from '../src/textOverlays.js';
import type { Command, OverlayItem } from '@vidcut/shared';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-to-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  return { dir, store, svc: new TextCardService(dir, raster) };
}

const TEXT = {
  text: '大標題',
  fontFamily: 'Heiti TC',
  fontSize: 72,
  fill: '#ffffff',
  stroke: '#000000',
};
const ADD: Command = {
  name: 'addOverlay',
  overlay: {
    id: 'ov1',
    imagePath: '',
    text: TEXT,
    start: 0,
    duration: 3,
    position: { x: 0.5, y: 0.4, scale: 1 },
  } as OverlayItem,
};

describe('resolveTextCommand + 命令層', () => {
  it('addOverlay 帶 text:resolve 後 imagePath 指向實存的字卡,applyCommand 一次成立', async () => {
    const { dir, store, svc } = await setup();
    const resolved = await resolveTextCommand(svc, store, ADD);
    const r = applyCommand(store, 'human', resolved);
    expect(r.ok).toBe(true);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('大標題');
    expect(ov.imagePath).toMatch(/^derived\/text\/[0-9a-f]{16}\.base\.png$/);
    expect((await stat(join(dir, ov.imagePath))).size).toBeGreaterThan(0);
  }, 30_000);

  it('updateOverlay 改 text:text 與 imagePath 在同一版本一起變(原子)', async () => {
    const { store, svc } = await setup();
    applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD));
    const before = store.doc.tracks.overlays[0]!.imagePath;
    const cmd: Command = {
      name: 'updateOverlay',
      id: 'ov1',
      patch: { text: { ...TEXT, text: '改標題' } },
    };
    const r = applyCommand(store, 'human', await resolveTextCommand(svc, store, cmd));
    expect(r.ok).toBe(true);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('改標題');
    expect(ov.imagePath).not.toBe(before);
  }, 30_000);

  it('updateOverlay 對「純圖 overlay」送 text:不產卡(原樣放行),命令層再拒絕,原圖零損傷', async () => {
    const { dir, store, svc } = await setup();
    store.mutate('human', 'seed png overlay', (d) => {
      d.tracks.overlays = [
        {
          id: 'rank0',
          imagePath: 'assets/rank_ov_0.png',
          start: 0,
          duration: 3,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
      ];
    });
    const cmd: Command = {
      name: 'updateOverlay',
      id: 'rank0',
      patch: { text: { ...TEXT, text: '不該生效' } },
    };
    // 前置不產卡:回同一個物件參考(有產卡的話會是新物件、帶 imagePath),
    // derived/text/ 也不該多出任何孤兒卡。
    expect(await resolveTextCommand(svc, store, cmd)).toBe(cmd);
    await expect(stat(join(dir, 'derived', 'text'))).rejects.toThrow();
    // 命令層是真正的防線(UI 直送也走這裡)
    const r = applyCommand(store, 'human', cmd);
    expect(r.ok).toBe(false);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.imagePath).toBe('assets/rank_ov_0.png');
    expect(ov.text).toBeUndefined();
  }, 30_000);

  it('無 text 的命令原樣通過(既有排名 PNG 行為不變)', async () => {
    const { store, svc } = await setup();
    const cmd: Command = {
      name: 'addOverlay',
      overlay: {
        id: 'png1',
        imagePath: 'assets/x.png',
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0, scale: 1 },
      },
    };
    expect(await resolveTextCommand(svc, store, cmd)).toBe(cmd);
  });

  it('驗證:text overlay 空字串被拒;text overlay 的 imagePath 空(未 resolve)被拒', async () => {
    const { store } = await setup();
    const bad1: Command = {
      name: 'addOverlay',
      overlay: {
        ...(ADD as Extract<Command, { name: 'addOverlay' }>).overlay,
        text: { ...TEXT, text: '  ' },
      },
    };
    expect(applyCommand(store, 'human', bad1).ok).toBe(false);
    expect(applyCommand(store, 'human', ADD).ok).toBe(false); // imagePath 仍是 ''
  });

  it('setOverlays 混合文字與純圖 overlay:文字項目各自產出真的 derived/text 字卡,純圖項目原封不動', async () => {
    const { dir, store, svc } = await setup();
    const png: OverlayItem = {
      id: 'png1',
      imagePath: 'assets/x.png',
      start: 5,
      duration: 1,
      position: { x: 0.5, y: 0, scale: 1 },
    };
    const cmd: Command = {
      name: 'setOverlays',
      overlays: [(ADD as Extract<Command, { name: 'addOverlay' }>).overlay, png],
    };
    const resolved = await resolveTextCommand(svc, store, cmd);
    expect(resolved).not.toBe(cmd);
    const setCmd = resolved as Extract<Command, { name: 'setOverlays' }>;
    const txt = setCmd.overlays.find((o) => o.id === 'ov1')!;
    expect(txt.imagePath).toMatch(/^derived\/text\/[0-9a-f]{16}\.base\.png$/);
    expect((await stat(join(dir, txt.imagePath))).size).toBeGreaterThan(0);
    const plain = setCmd.overlays.find((o) => o.id === 'png1')!;
    expect(plain).toEqual(png); // 沒有 text 的項目原樣、原封不動(同結構)

    const r = applyCommand(store, 'human', resolved);
    expect(r.ok).toBe(true);
  }, 30_000);

  it('setOverlays 陣列裡沒有任何 text overlay 時:resolveTextCommand 回同一個物件參考', async () => {
    const { store, svc } = await setup();
    const cmd: Command = {
      name: 'setOverlays',
      overlays: [
        {
          id: 'png1',
          imagePath: 'assets/x.png',
          start: 0,
          duration: 1,
          position: { x: 0.5, y: 0, scale: 1 },
        },
      ],
    };
    expect(await resolveTextCommand(svc, store, cmd)).toBe(cmd);
  });

  it('setOverlays 直接呼叫 applyCommand(繞過 resolveTextCommand):文字 overlay 的 imagePath 為空字串被拒,文件完全不動', async () => {
    const { store } = await setup();
    const beforeOverlays = store.doc.tracks.overlays;
    const beforeVersion = store.version;
    const cmd: Command = {
      name: 'setOverlays',
      overlays: [(ADD as Extract<Command, { name: 'addOverlay' }>).overlay], // imagePath 仍是 ''
    };
    const r = applyCommand(store, 'human', cmd);
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.overlays).toBe(beforeOverlays);
    expect(store.doc.tracks.overlays).toEqual([]);
    expect(store.version).toBe(beforeVersion);
  });
});

describe('updateOverlay text 命令直接呼叫 applyCommand(繞過 resolveTextCommand 的防線)', () => {
  async function seeded() {
    const { store, svc } = await setup();
    const r = applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD));
    expect(r.ok).toBe(true);
    return { store, svc };
  }

  it('patch.text 有值但沒帶 imagePath 鍵(未經 resolve):被拒,text 與 imagePath 都不變、版本不動(零殘留)', async () => {
    const { store } = await seeded();
    const beforeOv = store.doc.tracks.overlays[0]!;
    const beforeText = beforeOv.text;
    const beforeImagePath = beforeOv.imagePath;
    const beforeVersion = store.version;
    const cmd: Command = {
      name: 'updateOverlay',
      id: 'ov1',
      patch: { text: { ...TEXT, text: '未經 resolve 的新標題' } },
    };
    const r = applyCommand(store, 'human', cmd); // 直接呼叫,跳過 resolveTextCommand
    expect(r.ok).toBe(false);
    const after = store.doc.tracks.overlays[0]!;
    expect(after.text).toEqual(beforeText);
    expect(after.imagePath).toBe(beforeImagePath);
    expect(store.version).toBe(beforeVersion);
  }, 30_000);

  it('patch.text 有值且 imagePath 為空字串:被拒,text 與 imagePath 都不變、版本不動', async () => {
    const { store } = await seeded();
    const beforeOv = store.doc.tracks.overlays[0]!;
    const beforeText = beforeOv.text;
    const beforeImagePath = beforeOv.imagePath;
    const beforeVersion = store.version;
    const cmd: Command = {
      name: 'updateOverlay',
      id: 'ov1',
      patch: { text: { ...TEXT, text: '改' }, imagePath: '' },
    };
    const r = applyCommand(store, 'human', cmd);
    expect(r.ok).toBe(false);
    const after = store.doc.tracks.overlays[0]!;
    expect(after.text).toEqual(beforeText);
    expect(after.imagePath).toBe(beforeImagePath);
    expect(store.version).toBe(beforeVersion);
  }, 30_000);

  it('patch.text.text 為空白字串:被拒,版本不動', async () => {
    const { store } = await seeded();
    const beforeOv = store.doc.tracks.overlays[0]!;
    const beforeText = beforeOv.text;
    const beforeImagePath = beforeOv.imagePath;
    const beforeVersion = store.version;
    const cmd: Command = {
      name: 'updateOverlay',
      id: 'ov1',
      patch: { text: { ...TEXT, text: '   ' } },
    };
    const r = applyCommand(store, 'human', cmd);
    expect(r.ok).toBe(false);
    const after = store.doc.tracks.overlays[0]!;
    expect(after.text).toEqual(beforeText);
    expect(after.imagePath).toBe(beforeImagePath);
    expect(store.version).toBe(beforeVersion);
  }, 30_000);

  it('patch.text.fontSize 為 0 或負值:被拒,版本不動', async () => {
    const { store } = await seeded();
    const beforeVersion = store.version;
    for (const fontSize of [0, -1]) {
      const beforeOv = store.doc.tracks.overlays[0]!;
      const beforeText = beforeOv.text;
      const beforeImagePath = beforeOv.imagePath;
      const cmd: Command = {
        name: 'updateOverlay',
        id: 'ov1',
        patch: { text: { ...TEXT, fontSize } },
      };
      const r = applyCommand(store, 'human', cmd);
      expect(r.ok).toBe(false);
      const after = store.doc.tracks.overlays[0]!;
      expect(after.text).toEqual(beforeText);
      expect(after.imagePath).toBe(beforeImagePath);
    }
    expect(store.version).toBe(beforeVersion);
  }, 30_000);
});

// 前置（resolveTextCommand）碰到超出像素預算的文字時要**跳過產卡**，讓命令層去回一句
// 可讀的拒絕理由——跟「overlay 不存在」「目標是純圖 overlay」同一個模式。
// 直接產卡的話 svc.ensure 會 throw，呼叫端只會看到一句包了 stack 的「字卡產生失敗」。
describe('resolveTextCommand 的像素預算', () => {
  const BOMB = { ...TEXT, text: `標題${'\n'.repeat(3000)}` }; // 3001 行 → 約 250 Mpx

  it('addOverlay 帶超標的 text：不產卡（cmd 原樣放行），命令層回「太大」且文件不動', async () => {
    const { dir, store, svc } = await setup();
    const cmd: Command = {
      name: 'addOverlay',
      overlay: { ...(ADD as Extract<Command, { name: 'addOverlay' }>).overlay, text: BOMB },
    };
    const t0 = Date.now();
    const resolved = await resolveTextCommand(svc, store, cmd);
    expect(Date.now() - t0).toBeLessThan(2000); // 沒有真的去畫（畫下去要好幾分鐘）
    expect(resolved).toBe(cmd); // 原樣放行：沒有塞 imagePath
    const r = applyCommand(store, 'human', resolved);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/too large/);
    expect(store.doc.tracks.overlays).toHaveLength(0);
    // 也沒有在 derived/text/ 留下孤兒卡
    await expect(stat(join(dir, 'derived', 'text'))).rejects.toThrow();
  }, 30_000);

  it('updateOverlay 改成超標的 text：原本的 overlay（含 imagePath）完全不動', async () => {
    const { store, svc } = await setup();
    applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD));
    const before = store.doc.tracks.overlays[0]!.imagePath;
    const cmd: Command = { name: 'updateOverlay', id: 'ov1', patch: { text: BOMB } };
    const r = applyCommand(store, 'human', await resolveTextCommand(svc, store, cmd));
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.overlays[0]!.imagePath).toBe(before);
    expect(store.doc.tracks.overlays[0]!.text?.text).toBe('大標題');
  }, 30_000);
});

// 光柵器換版本（PillowRasterizer.id 往上加）之後，既有專案的 imagePath 仍指著舊 hash
// 的檔案，而且因為是內容定址，使用者重打一模一樣的字也救不回來（同輸入→同 key→命中
// 舊卡）。2026-08-04 就是這樣讓「加了自動換行」對已存檔的作品完全沒有發生：長文字的
// 字卡繼續維持「排成一行、頭尾被畫布切掉」的樣子。
describe('refreshTextOverlayCards：光柵器換版本後既有專案的字卡要跟上', () => {
  it('imagePath 對不上就重新產卡並更新；第二次呼叫是完全靜默的 no-op', async () => {
    const { dir, store, svc } = await setup();
    const resolved = await resolveTextCommand(svc, store, ADD);
    expect(applyCommand(store, 'human', resolved).ok).toBe(true);
    const good = store.doc.tracks.overlays[0]!.imagePath;

    // 模擬「舊版光柵器產的卡」：把 imagePath 換成一個不同 hash 的路徑
    store.mutate('human', 'simulate stale card', (d) => {
      d.tracks.overlays[0]!.imagePath = 'derived/text/0000000000000000.base.png';
    });
    const staleVersion = store.version;

    const n = await refreshTextOverlayCards(svc, store);
    expect(n).toBe(1);
    const fixed = store.doc.tracks.overlays[0]!.imagePath;
    expect(fixed).toBe(good); // 回到這組輸入「現在」該有的那張卡
    expect((await stat(join(dir, fixed))).size).toBeGreaterThan(0); // 檔案真的在
    expect(store.version).toBeGreaterThan(staleVersion); // 真的送了命令

    // 冪等：已經對上了就不該再送任何命令（否則每次開機都灌爆 undo history）
    const after = store.version;
    expect(await refreshTextOverlayCards(svc, store)).toBe(0);
    expect(store.version).toBe(after);
  }, 60_000);

  // 2026-08-05：這道遷移原本送的是 `patch: { text, imagePath }`，而 text 是**迴圈開頭抓的
  // 快照**。產卡要 spawn Pillow（overlay 多的話累積好幾秒），正好落在使用者剛開檔開始
  // 動手的那段時間——快照送回去就是把他這段時間的編輯覆蓋掉。而且每個既有專案的第一次
  // 開啟都會走到這條路。
  it('產卡途中使用者改了字：不得把快照裡的舊文字寫回去', async () => {
    const { store, svc } = await setup();
    expect(applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD)).ok).toBe(true);
    store.mutate('human', 'simulate stale card', (d) => {
      d.tracks.overlays[0]!.imagePath = 'derived/text/0000000000000000.base.png';
    });

    // 在 ensure() 回來之後、遷移送命令之前，插入一次真實的使用者編輯（走正規命令層）。
    // 這是最接近實際競態的注入點：遷移手上那張卡已經產好，但它描述的文字已經過期了。
    let injected = false;
    const racing = Object.create(svc) as TextCardService;
    racing.ensure = async (req) => {
      const r = await svc.ensure(req);
      if (!injected) {
        injected = true;
        const edit: Command = {
          name: 'updateOverlay',
          id: 'ov1',
          patch: { text: { ...TEXT, text: '使用者剛打的字' } },
        };
        expect(applyCommand(store, 'human', await resolveTextCommand(svc, store, edit)).ok).toBe(
          true,
        );
      }
      return r;
    };

    expect(await refreshTextOverlayCards(racing, store)).toBe(0); // 這張卡已經不是它要的了
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('使用者剛打的字'); // 使用者的編輯毫髮無傷
    // 改字那條路徑（resolveTextCommand）自己會產對應的新卡，不需要遷移代勞
    expect(ov.imagePath).not.toBe('derived/text/0000000000000000.base.png');
    expect(ov.imagePath).toBe(svc.relBasePath(svc.keyOf(overlayTextToCardRequest(ov.text!, 1080))));
  }, 60_000);

  // 這是一次系統維護，不是使用者做過的編輯。走一般 mutate 的話它會是開檔後 undo 堆疊裡
  // 唯一的一筆——使用者反射性按一次 Cmd+Z 撤掉的就是它，imagePath 被還原回舊 hash；
  // derived/ 若已被清過，那個檔案根本不存在，匯出時 `ffmpeg -i` 讀不到就整支失敗。
  it('遷移不進 undo 堆疊：開檔後第一次 Cmd+Z 不得撤掉它（但仍記歷史、仍落盤）', async () => {
    const { dir, store, svc } = await setup();
    expect(applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD)).ok).toBe(true);
    const good = store.doc.tracks.overlays[0]!.imagePath;
    store.mutate('human', 'simulate stale card', (d) => {
      d.tracks.overlays[0]!.imagePath = 'derived/text/0000000000000000.base.png';
    });
    await store.flush();

    // 重新開檔——真實情境：undo 堆疊是空的，遷移是這次 session 的第一筆 mutation
    const fresh = await ProjectStore.load(join(dir, 'project.json'));
    const v0 = fresh.version;
    expect(await refreshTextOverlayCards(new TextCardService(dir, raster), fresh)).toBe(1);
    expect(fresh.doc.tracks.overlays[0]!.imagePath).toBe(good);
    expect(fresh.version).toBeGreaterThan(v0); // 其餘照常：版本推進、廣播、落盤
    expect(fresh.history().at(-1)?.label).toBe('edit overlay'); // 歷史查得到，只是不可撤銷

    expect(fresh.undo('human')).toBeNull(); // 沒有任何「使用者做過的編輯」可以撤
    expect(fresh.doc.tracks.overlays[0]!.imagePath).toBe(good); // 修好的指標留在原地
  }, 60_000);

  it('純圖 overlay 不受影響（沒有 text 就沒有卡可以重解析）', async () => {
    const { store, svc } = await setup();
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'img1',
          imagePath: 'assets/rank.png',
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0, scale: 1 },
        } as OverlayItem,
      }).ok,
    ).toBe(true);
    const v = store.version;
    expect(await refreshTextOverlayCards(svc, store)).toBe(0);
    expect(store.doc.tracks.overlays[0]!.imagePath).toBe('assets/rank.png');
    expect(store.version).toBe(v);
  }, 30_000);
});
