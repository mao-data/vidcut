import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { Inspector } from './Inspector.js';
import { CaptionList } from './CaptionList.js';
import { Activity } from './Activity.js';
import { ExportMenu } from './ExportMenu.js';
import { ReviewBar } from './ReviewBar.js';
import { Player } from '../player/Player.js';
import { Timeline } from '../timeline/Timeline.js';
import { PanelResizer } from '../PanelResizer.js';
import * as ws from '../ws.js';
import { seedProject, resetStores } from '../test/fixtures.js';

/**
 * 每個面板在「尚未載入專案」與「已載入」兩種狀態都必須掛得起來。
 * 冷載入白屏（React #185）就是 doc=null 那條路徑炸掉——一個會無限重渲染的
 * selector 會讓 render() 直接丟例外，所以「不丟例外」是有效斷言，不是空測試。
 */
const PANELS = {
  Inspector: () => <Inspector />,
  CaptionList: () => <CaptionList />,
  Activity: () => <Activity />,
  ExportMenu: () => <ExportMenu />,
  ReviewBar: () => <ReviewBar />,
  Player: () => <Player />,
  Timeline: () => <Timeline />,
  PanelResizer: () => <PanelResizer side="left" onResizingChange={() => {}} />,
};

describe('panel smoke tests', () => {
  beforeEach(() => {
    resetStores();
    vi.spyOn(ws, 'sendCommand').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  for (const [name, Comp] of Object.entries(PANELS)) {
    it(`${name} mounts with no project loaded`, () => {
      expect(() => render(<Comp />)).not.toThrow();
    });

    it(`${name} mounts with a project loaded`, () => {
      seedProject();
      expect(() => render(<Comp />)).not.toThrow();
    });
  }
});
