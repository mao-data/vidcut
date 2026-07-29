import { useProject } from './stores/project.js';
import { Player } from './player/Player.js';
import { Timeline } from './timeline/Timeline.js';

export function App() {
  const doc = useProject((s) => s.doc);
  const version = useProject((s) => s.version);
  const connected = useProject((s) => s.connected);
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0 }}>
        {connected ? '🟢' : '🔴'} {doc?.name ?? '—'} v{version}
      </p>
      <Player />
      <Timeline />
    </div>
  );
}
