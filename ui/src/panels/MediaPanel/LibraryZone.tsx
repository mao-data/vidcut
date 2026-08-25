import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Music, Upload, Import, Trash2, ImageIcon } from 'lucide-react';
import { usePlayback } from '../../stores/playback.js';
import { useToast } from '../../stores/toast.js';
import { sendCommand } from '../../ws.js';

/**
 * 素材庫的 UI 端最小型別——**刻意不 import server 的 `LibraryAsset`/`LibraryListing`**
 * （task brief 明文要求）：server workspace 帶一堆 node-only 依賴（fs/child_process…），
 * 從 UI 端 import 型別雖然 tree-shake 掉執行期程式碼，但會把整個模組圖拖進 Vite 的
 * 解析範圍，也讓 UI 對 server 的內部檔案結構產生耦合。這裡只列 UI 實際用到的欄位，
 * 形狀對齊 `GET /api/library` 的回應（server `LibraryListing` = `LibraryAsset` + `broken`）。
 */
interface LibraryRow {
  id: string;
  kind: 'media' | 'image';
  hash: string;
  file: string;
  probe: { duration: number; hasVideo?: boolean };
  label: string;
  tags: string[];
  broken: boolean;
}

/** 搜尋輸入框 300ms debounce 用的模組級 timer——款式照抄 CaptionList `schedulePreview`。 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function cancelSearchDebounce(): void {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}

function extOf(file: string): string {
  const i = file.lastIndexOf('.');
  return i === -1 ? '' : file.slice(i);
}

/** 縮圖：media→filmstrip 首格、audio→icon、image→本體圖檔。`<img draggable={false}>`（鐵則）。 */
function LibraryThumb({ a }: { a: LibraryRow }) {
  const box: CSSProperties = {
    width: 48,
    height: 27,
    flexShrink: 0,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  if (a.kind === 'image') {
    return (
      <div style={box}>
        <img
          src={`/library/files/${a.hash}${extOf(a.file)}`}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    );
  }
  const audioOnly = a.probe.hasVideo === false;
  if (audioOnly) {
    return (
      <div style={box}>
        <Music size={13} />
      </div>
    );
  }
  return (
    <div style={box}>
      <img
        src={`/library/derived/${a.hash}/filmstrip.jpg`}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  );
}

/**
 * 素材庫區：跨專案搜尋／上傳／匯入／標籤／刪除。
 * 資料流刻意不進 zustand——沒有跨元件消費者，遵守「fetch 散元件層」現況慣例
 * （見 task brief）。掛載與每次寫操作（上傳/匯入/改標籤/刪除）後都 refresh()。
 */
export function LibraryZone() {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string; label: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = (opts?: { query?: string; tag?: string | null }): void => {
    const query_ = opts && 'query' in opts ? opts.query : undefined;
    const tag_ = opts && 'tag' in opts ? opts.tag : undefined;
    const q = query_ !== undefined ? query_ : undefined;
    const t = tag_ !== undefined ? tag_ : undefined;
    const params = new URLSearchParams();
    if (q) params.set('query', q);
    if (t) params.set('tag', t);
    const qs = params.toString();
    void fetch(qs ? `/api/library?${qs}` : '/api/library')
      .then((r) => (r.ok ? (r.json() as Promise<{ assets: LibraryRow[] }>) : null))
      .then((res) => {
        if (!res) return;
        setRows(res.assets);
      });
  };

  // 掛載即查一次（未帶任何篩選）。refresh 是每次 render 重建的閉包，
  // 依賴陣列刻意留空——只在掛載時跑一次，不是每次 refresh 變了就重跑
  // （這個 repo 沒有裝 react-hooks/exhaustive-deps，故意留空不需要 disable 註解）。
  useEffect(() => {
    refresh();
    return () => cancelSearchDebounce();
  }, []);

  const scheduleSearch = (q: string): void => {
    cancelSearchDebounce();
    searchTimer = setTimeout(() => {
      searchTimer = null;
      refresh({ query: q, tag: tagFilter });
    }, 300);
  };

  const clickTag = (tag: string): void => {
    const next = tagFilter === tag ? null : tag;
    setTagFilter(next);
    refresh({ query, tag: next });
  };

  const onFilesPicked = async (files: FileList): Promise<void> => {
    // 逐檔序列上傳（不並發）：body 直接傳 File 物件本身——不 arrayBuffer，讓瀏覽器
    // 串流上傳（server 對應以 pipeline() 落地暫存檔，同一份「不吃記憶體」設計見 app.ts 註解）。
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      useToast.getState().show(`Uploading ${f.name}…`);
      try {
        const res = await fetch(`/api/library?${new URLSearchParams({ name: f.name })}`, {
          method: 'POST',
          body: f,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          useToast.getState().show(body?.error ?? `Upload failed: ${f.name}`);
          continue;
        }
      } catch {
        useToast.getState().show(`Upload failed: ${f.name}`);
        continue;
      }
    }
    useToast.getState().show('Upload complete');
    refresh({ query, tag: tagFilter });
  };

  const doImport = async (a: LibraryRow): Promise<void> => {
    if (a.kind === 'image') {
      const res = await fetch(`/api/library/${a.id}/import`, { method: 'POST' });
      if (!res.ok) return;
      const { relPath } = (await res.json()) as { relPath: string };
      const id = `ov_${Math.random().toString(36).slice(2, 10)}`;
      sendCommand({
        name: 'addOverlay',
        overlay: {
          id,
          imagePath: relPath,
          start: Number(usePlayback.getState().time.toFixed(3)),
          duration: 3,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
      });
      useToast.getState().show('Placed as overlay');
      return;
    }
    const res = await fetch(`/api/library/${a.id}/import`, { method: 'POST' });
    if (!res.ok) return;
    useToast.getState().show('Imported');
    refresh({ query, tag: tagFilter });
  };

  const doDelete = (a: LibraryRow): void => {
    const ok = window.confirm(
      'Delete from library? Projects referencing this file will lose it at export.',
    );
    if (!ok) return;
    void fetch(`/api/library/${a.id}`, { method: 'DELETE' }).then((r) => {
      if (!r.ok) return;
      refresh({ query, tag: tagFilter });
    });
  };

  const commitLabel = (a: LibraryRow): void => {
    if (!draft || draft.id !== a.id) return;
    const label = draft.label.trim();
    setDraft(null);
    if (label === '' || label === a.label) return;
    void fetch(`/api/library/${a.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }).then((r) => {
      if (!r.ok) return;
      refresh({ query, tag: tagFilter });
    });
  };

  return (
    <div className="panel-col" style={{ minWidth: 0 }}>
      <div className="panel-bar" style={{ gap: 4 }}>
        <input
          placeholder="Search library"
          value={query}
          onChange={(e) => {
            const v = e.target.value;
            setQuery(v);
            scheduleSearch(v);
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*,.mkv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void onFilesPicked(files);
            e.target.value = '';
          }}
        />
        <button
          className="icon-btn"
          title="Upload to library"
          aria-label="Upload to library"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={13} />
        </button>
      </div>
      <div className="panel-body">
        {rows.length === 0 && (
          <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
            No library assets yet. Upload a file or save one from Project media.
          </div>
        )}
        {rows.map((a) => (
          <div
            key={a.id}
            className="rowline"
            style={{ display: 'flex', gap: 8, padding: '4px 8px' }}
          >
            <LibraryThumb a={a} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {draft?.id === a.id ? (
                <input
                  autoFocus
                  value={draft.label}
                  onChange={(e) => setDraft({ id: a.id, label: e.target.value })}
                  onBlur={() => commitLabel(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitLabel(a);
                    if (e.key === 'Escape') setDraft(null);
                  }}
                  style={{ minWidth: 0 }}
                />
              ) : (
                <div
                  onDoubleClick={() => setDraft({ id: a.id, label: a.label })}
                  title="Double-click to edit"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.label}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {a.tags.map((t) => (
                  <span
                    key={t}
                    className="tag"
                    onClick={() => clickTag(t)}
                    style={{ cursor: 'pointer' }}
                  >
                    {t}
                  </span>
                ))}
                {a.broken && <span style={{ color: 'var(--text-3)' }}>broken</span>}
              </div>
            </div>
            <button
              className="icon-btn"
              title="Import"
              aria-label="Import"
              disabled={a.broken}
              onClick={() => void doImport(a)}
            >
              {a.kind === 'image' ? <ImageIcon size={13} /> : <Import size={13} />}
            </button>
            <button
              className="icon-btn"
              title="Delete"
              aria-label="Delete"
              onClick={() => doDelete(a)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
