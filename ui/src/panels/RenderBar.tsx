import { useProject } from '../stores/project.js';
import { sendRender } from '../ws.js';

/** 渲染按鈕 + 進度 + 成品連結。 */
export function RenderBar() {
  const render = useProject((s) => s.doc?.render);
  const running = render?.status === 'running';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        borderTop: '1px solid #333',
      }}
    >
      <button onClick={() => sendRender()} disabled={running} style={{ padding: '6px 14px' }}>
        {running ? '渲染中…' : '🎬 渲染成品'}
      </button>
      {running && (
        <div
          style={{
            flex: 1,
            maxWidth: 300,
            height: 8,
            background: '#333',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.round((render?.progress ?? 0) * 100)}%`,
              height: '100%',
              background: '#4af',
              transition: 'width 0.2s',
            }}
          />
        </div>
      )}
      {render?.status === 'done' && render.lastOutput && (
        <a
          href={`/media/${render.lastOutput}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#6cf' }}
        >
          ✓ 開啟成品（{render.lastOutput.split('/').pop()}）
        </a>
      )}
      {render?.status === 'error' && (
        <span style={{ color: '#f66' }}>渲染失敗：{render.error}</span>
      )}
    </div>
  );
}
