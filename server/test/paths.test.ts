import { describe, it, expect } from 'vitest';
import { resolveMediaPath } from '../src/paths.js';

describe('resolveMediaPath', () => {
  it('相對路徑接在專案資料夾底下', () => {
    expect(resolveMediaPath('/proj', 'a.mp4')).toBe('/proj/a.mp4');
    expect(resolveMediaPath('/proj', 'assets/b.mov')).toBe('/proj/assets/b.mov');
  });

  it('絕對路徑原樣回傳，不接在專案底下', () => {
    expect(resolveMediaPath('/proj', '/Users/me/Movies/c.mp4')).toBe('/Users/me/Movies/c.mp4');
  });

  it('相對路徑中的 .. 會被正規化', () => {
    expect(resolveMediaPath('/proj/sub', '../d.mp4')).toBe('/proj/d.mp4');
  });

  it('空字串回專案資料夾本身', () => {
    expect(resolveMediaPath('/proj', '')).toBe('/proj');
  });
});
