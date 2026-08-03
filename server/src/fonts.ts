// server/src/fonts.ts — fontFamily → 字型檔對照。啟動時用 Pillow 實測,開不了的剔除
// (這台機器 PingFang.ttc 會 OSError,若照單全收 fontFamily 就是死欄位)。
import type { PillowRasterizer } from './rasterizer.js';

export interface FontEntry {
  id: string;
  family: string;
  path: string;
}

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
];

export async function loadFontTable(r: PillowRasterizer): Promise<FontEntry[]> {
  const table: FontEntry[] = [];
  for (const c of CANDIDATES) {
    if (await r.probeFont(c.path)) table.push(c);
    else console.warn(`⚠ 字型不可用(已剔除):${c.family} @ ${c.path}`);
  }
  return table;
}

export function fontResolver(table: FontEntry[]): (family: string) => string | undefined {
  return (family) => (table.find((f) => f.family === family) ?? table[0])?.path;
}
