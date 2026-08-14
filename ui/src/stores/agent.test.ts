import { describe, it, expect, beforeEach } from 'vitest';
import { useAgent, agentPhase, currentCall, sessionCounts, NO_CALLS } from './agent.js';
import { useProject } from './project.js';

beforeEach(() => {
  useAgent.setState({ calls: NO_CALLS });
  useProject.setState({ doc: null, version: 0, connected: false });
});

const start = (callId: string, tool: string) =>
  useAgent.getState().apply({ type: 'agentActivity', phase: 'start', tool, callId });
const end = (callId: string, tool: string) =>
  useAgent.getState().apply({ type: 'agentActivity', phase: 'end', tool, callId });

describe('useAgent 進行中呼叫集合（B9/B10/N1/N4/N7）', () => {
  it('start 加入、end 移除（B9/B10）', () => {
    start('1', 'set_timeline');
    expect(Object.keys(useAgent.getState().calls)).toEqual(['1']);
    expect(useAgent.getState().calls['1'].tool).toBe('set_timeline');
    end('1', 'set_timeline');
    expect(useAgent.getState().calls).toEqual({});
  });

  it('start 記下 startedAt（顯示用；經過秒數由元件層算）', () => {
    const before = Date.now();
    start('1', 'transcribe');
    const after = Date.now();
    const at = useAgent.getState().calls['1'].startedAt;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('多呼叫並發：N 個 start 未 end → 集合大小為 N（N4）', () => {
    start('1', 'get_project');
    start('2', 'add_overlay');
    start('3', 'render');
    expect(Object.keys(useAgent.getState().calls)).toHaveLength(3);
    expect(agentPhase(true, useAgent.getState().calls)).toBe('working');
  });

  it('end 只移除自己那筆，其他 callId 不受影響（N1）', () => {
    start('1', 'transcribe');
    start('2', 'render');
    end('1', 'transcribe');
    expect(Object.keys(useAgent.getState().calls)).toEqual(['2']);
    expect(useAgent.getState().calls['2'].tool).toBe('render');
  });

  it('同名工具不同 callId 是兩筆，不會互相覆蓋（callId 才是身分）', () => {
    start('1', 'get_frame');
    start('2', 'get_frame');
    end('1', 'get_frame');
    expect(Object.keys(useAgent.getState().calls)).toEqual(['2']);
    expect(agentPhase(true, useAgent.getState().calls)).toBe('working');
  });

  it('沒有對應 start 的 end 不炸、集合維持不變（N7）', () => {
    start('1', 'render');
    expect(() => end('99', 'ghost')).not.toThrow();
    expect(Object.keys(useAgent.getState().calls)).toEqual(['1']);
  });
});

describe('三態推導（B11）', () => {
  it('connected=false → offline（就算集合非空也是 offline）', () => {
    expect(agentPhase(false, {})).toBe('offline');
    start('1', 'render');
    expect(agentPhase(false, useAgent.getState().calls)).toBe('offline');
  });

  it('connected=true 且集合空 → idle', () => {
    expect(agentPhase(true, {})).toBe('idle');
  });

  it('connected=true 且集合非空 → working', () => {
    start('1', 'render');
    expect(agentPhase(true, useAgent.getState().calls)).toBe('working');
  });
});

describe('斷線清空（B13/N3）', () => {
  it('setConnected(false) 清空進行中集合——不得卡假忙碌', () => {
    start('1', 'transcribe');
    start('2', 'render');
    useProject.getState().setConnected(false);
    expect(useAgent.getState().calls).toEqual({});
  });

  it('setConnected(true) 不清空（重連後的新 start 不該被誤殺）', () => {
    useProject.getState().setConnected(true);
    start('1', 'render');
    useProject.getState().setConnected(true);
    expect(Object.keys(useAgent.getState().calls)).toEqual(['1']);
  });

  it('clear() 之後 phase 由 working 落回 idle（連著的話）', () => {
    start('1', 'render');
    useAgent.getState().clear();
    expect(agentPhase(true, useAgent.getState().calls)).toBe('idle');
    expect(useAgent.getState().calls).toBe(NO_CALLS);
  });

  it('本來就空的時候 clear() 不換 reference（斷線重連會連發，不能每次都讓訂閱者重繪）', () => {
    const before = useAgent.getState().calls;
    useAgent.getState().clear();
    useAgent.getState().clear();
    expect(useAgent.getState().calls).toBe(before);
  });
});

describe('顯示用 selector：最新一筆（B12）', () => {
  it('集合空回 null', () => {
    expect(currentCall({})).toBeNull();
  });

  it('回最後加入的那筆的 tool 與 startedAt', () => {
    start('1', 'get_project');
    start('2', 'transcribe');
    const cur = currentCall(useAgent.getState().calls);
    expect(cur?.tool).toBe('transcribe');
    expect(cur?.startedAt).toBe(useAgent.getState().calls['2'].startedAt);
  });

  it('最新一筆 end 掉之後回退到還在跑的前一筆', () => {
    start('1', 'get_project');
    start('2', 'transcribe');
    end('2', 'transcribe');
    expect(currentCall(useAgent.getState().calls)?.tool).toBe('get_project');
  });

  it('同一份集合連續呼叫回同一個 reference（selector 不得產新物件——zustand v5 鐵則）', () => {
    start('1', 'render');
    const calls = useAgent.getState().calls;
    expect(currentCall(calls)).toBe(currentCall(calls));
  });

  it('空集合的 calls 是模組級常數 reference（同上）', () => {
    start('1', 'render');
    end('1', 'render');
    expect(useAgent.getState().calls).toBe(NO_CALLS);
  });
});

describe('session 統計純函數（B14）', () => {
  const e = (version: number, source: 'ai' | 'human') => ({
    version,
    label: 'x',
    source,
    ts: '2026-08-14T00:00:00Z',
  });

  it('依 source 分計 AI 與人', () => {
    expect(sessionCounts([e(1, 'ai'), e(2, 'human'), e(3, 'ai')])).toEqual({ ai: 2, human: 1 });
  });

  it('空清單回零', () => {
    expect(sessionCounts([])).toEqual({ ai: 0, human: 0 });
  });

  it('全是人時 ai 為 0（不是把總數算給 AI）', () => {
    expect(sessionCounts([e(1, 'human'), e(2, 'human')])).toEqual({ ai: 0, human: 2 });
  });
});
