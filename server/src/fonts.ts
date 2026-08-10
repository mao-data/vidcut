// server/src/fonts.ts — fontFamily → 字型檔對照。啟動時用 Pillow 實測,開不了的剔除
// (這台機器 PingFang.ttc 會 OSError,若照單全收 fontFamily 就是死欄位)。
import { existsSync } from 'node:fs';
import type { PillowRasterizer } from './rasterizer.js';

export interface FontEntry {
  id: string;
  family: string;
  path: string;
}

/**
 * ⚠️ **這串在 2026-08-05 之前只有 macOS 路徑**，所以在 Linux/CI 上字型表一定是空的
 * ——`fontResolver` 回 undefined、`text_card.py` 走自己的候選鏈（同樣只有 macOS 路徑）、
 * 全滅之後掉進 Pillow 內建的點陣字型。成品會燒進一排沒有 CJK 的小豆腐字，而且
 * **兩邊吃同一張壞卡，連 verify:wysiwyg 都是綠的**。加字型時記得 `text_card.py` 的
 * `FONT_CANDIDATES` 也要跟著加（那是沒有指定 fontPath 時的退路）。
 */
const CANDIDATES: FontEntry[] = [
  { id: 'heiti-tc', family: 'Heiti TC', path: '/System/Library/Fonts/STHeiti Medium.ttc' },
  { id: 'pingfang-tc', family: 'PingFang TC', path: '/System/Library/Fonts/PingFang.ttc' },
  {
    id: 'hiragino-gb',
    family: 'Hiragino Sans GB',
    path: '/System/Library/Fonts/Hiragino Sans GB.ttc',
  },
  {
    id: 'arial-unicode',
    family: 'Arial Unicode MS',
    path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  },
  // Linux（Debian/Ubuntu 的 fonts-noto-cjk / fonts-dejavu；Fedora/Arch 同名不同層）
  {
    id: 'noto-cjk',
    family: 'Noto Sans CJK',
    path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  },
  {
    id: 'noto-cjk-tt',
    family: 'Noto Sans CJK',
    path: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  },
  {
    id: 'noto-cjk-fedora',
    family: 'Noto Sans CJK',
    path: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  },
  { id: 'dejavu', family: 'DejaVu Sans', path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
  { id: 'dejavu-fedora', family: 'DejaVu Sans', path: '/usr/share/fonts/dejavu/DejaVuSans.ttf' },
  // Windows
  { id: 'msjh', family: 'Microsoft JhengHei', path: 'C:/Windows/Fonts/msjh.ttc' },
  { id: 'arial', family: 'Arial', path: 'C:/Windows/Fonts/arial.ttf' },
];

export async function loadFontTable(r: PillowRasterizer): Promise<FontEntry[]> {
  const table: FontEntry[] = [];
  for (const c of CANDIDATES) {
    if (await r.probeFont(c.path)) table.push(c);
    // 候選鏈跨三個作業系統，所以「這個路徑不存在」是常態（macOS 上永遠看不到 Linux 那幾條），
    // 逐個 warn 會在每次啟動洗出一整片雜訊、把真正值得看的訊息淹掉。只有**檔案在、
    // 但 Pillow 開不了**才值得說（權限、格式不支援、字型檔壞了——這台機器的 PingFang.ttc
    // 就是這種），因為那是「你以為有這個字型，其實用不了」。
    else if (existsSync(c.path)) console.warn(`⚠ 字型不可用(已剔除):${c.family} @ ${c.path}`);
  }
  // 空表不是「少幾個字型」，是**這台機器上 resolver 這條路完全交白卷**（回 undefined）。
  // 但這不等於匯出一定失敗：text_card.py 的 FONT_CANDIDATES 是這裡的嚴格超集（多三條
  // 路徑，見上面的檔頭註解），resolver 交白卷之後 text_card.py 仍會走它自己那份更長的
  // 候選鏈——只有連那份也全滅，才會回報 fontFallback、讓 render 真的中止（見
  // render.ts 的 fontFallbackError）。逐個候選的 warn 混在啟動訊息裡很容易被滑過去，
  // 所以這裡再說一次，且說清楚實際後果與解法。
  if (table.length === 0) {
    console.warn('⚠ 字型表是空的——這台機器上一個候選字型都開不了。');
    console.warn('  後果：字幕/文字 overlay 的字卡會用 Pillow 內建點陣字型畫（沒有中日韓字符），');
    console.warn('  而 render 會直接中止，不會把看不懂的字燒進成品。');
    console.warn('  解法：安裝字型（Debian/Ubuntu：apt install fonts-noto-cjk），');
    console.warn(`  或在 ${'server/src/fonts.ts'} 的 CANDIDATES 補上你機器上的路徑。`);
  }
  return table;
}

export function fontResolver(table: FontEntry[]): (family: string) => string | undefined {
  return (family) => (table.find((f) => f.family === family) ?? table[0])?.path;
}
