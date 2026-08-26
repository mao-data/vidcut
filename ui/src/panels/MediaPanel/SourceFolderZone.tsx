/**
 * ⚠️ 2026-08-26 起**未掛載**：Media 分頁扁平化（Project/Library 升為主分頁）時，
 * 「打路徑→掃描→勾選匯入」流程由 ProjectMediaZone 的上傳鈕（檔案/資料夾選擇器，
 * 走 POST /api/media）取代。檔案與單元測試保留：後端 /api/source + /api/import
 * 仍活著（MCP list_source/import_media 在用），若要復活這個 UI（或改成拖放）
 * 把它接回 App.tsx 的分頁即可。
 */
import { useEffect, useState } from 'react';
import { Library } from 'lucide-react';
import { useToast } from '../../stores/toast.js';

/** localStorage key：跨 session 記住上次掃描的素材夾路徑。 */
const DIR_STORAGE_KEY = 'vidcut.sourceDir';

/**
 * 素材夾掃描結果的 UI 端最小型別——形狀對齊 server `SourceListing`
 * （`GET /api/source` 的回應；見 `server/src/sourceFolder.ts`）。同 LibraryZone
 * 慣例，刻意不 import server 型別（server workspace 帶 node-only 依賴）。
 */
interface SourceFile {
  name: string;
  size: number;
  mtime: number;
  imported: boolean;
}

function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * 素材夾區：掃描本機目錄、勾選多選批次匯入、單檔直接入庫。
 * 資料流刻意不進 zustand（同 LibraryZone，無跨元件消費者）。
 * dir 值存 localStorage，掛載時回填並自動掃一次——避免每次切分頁都要重打路徑。
 */
export function SourceFolderZone() {
  const [dir, setDir] = useState(() => localStorage.getItem(DIR_STORAGE_KEY) ?? '');
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const scan = (d: string): void => {
    if (!d) return;
    setError(null);
    void fetch(`/api/source?${new URLSearchParams({ dir: d }).toString()}`)
      .then(async (r) => {
        const body = (await r.json()) as { dir: string; files: SourceFile[] } | { error: string };
        if (!r.ok) {
          setFiles([]);
          setError('error' in body ? body.error : 'scan failed');
          return;
        }
        if ('files' in body) {
          setFiles(body.files);
          setSelected(new Set());
        }
      })
      .catch(() => setError('scan failed'));
  };

  // 掛載即回填 localStorage 存的路徑並自動掃一次；依賴陣列刻意留空，只跑一次
  // （同 LibraryZone 慣例：這個 repo 沒裝 react-hooks/exhaustive-deps）。
  useEffect(() => {
    const saved = localStorage.getItem(DIR_STORAGE_KEY);
    if (saved) scan(saved);
  }, []);

  const doScan = (): void => {
    localStorage.setItem(DIR_STORAGE_KEY, dir);
    scan(dir);
  };

  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const importSelected = async (): Promise<void> => {
    const names = Array.from(selected);
    if (names.length === 0) return;
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, names }),
    });
    if (!res.ok) {
      useToast.getState().show('Import failed');
      return;
    }
    const body = (await res.json()) as {
      ok: Array<{ name: string; mediaId: string }>;
      failed: Array<{ name: string; error: string }>;
    };
    // 匯入後不 select（MediaPanel 頭部鐵則）；只重掃刷新 imported 標記。
    useToast.getState().show(`Imported ${body.ok.length}, failed ${body.failed.length}`);
    scan(dir);
  };

  const saveToLibrary = (f: SourceFile): void => {
    void fetch('/api/library/from-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${dir}/${f.name}` }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ existing: boolean }>) : null))
      .then((res) => {
        if (!res) return;
        useToast.getState().show(res.existing ? 'Already in library' : 'Saved to library');
      });
  };

  return (
    <div className="panel-col" style={{ minWidth: 0 }}>
      <div className="panel-bar" style={{ gap: 4, padding: '6px 12px' }}>
        <input
          className="mono"
          placeholder="/path/to/folder"
          title="Source folder path"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doScan();
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="seg" title="Scan" onClick={doScan}>
          Scan
        </button>
      </div>
      <div className="panel-body">
        {error && (
          <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
            {error}
          </div>
        )}
        {!error && files.length === 0 && (
          <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
            No files found. Enter a folder path and Scan.
          </div>
        )}
        {files.map((f) => (
          <div
            key={f.name}
            className="rowline media-row"
            style={{ display: 'flex', gap: 8, padding: '4px 12px', alignItems: 'center' }}
          >
            <input
              type="checkbox"
              checked={selected.has(f.name)}
              onChange={() => toggle(f.name)}
              aria-label={`Select ${f.name}`}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {f.name}
            </span>
            <span className="mono" style={{ color: 'var(--text-3)' }}>
              {fmtMB(f.size)} MB
            </span>
            {f.imported && <span className="tag">imported</span>}
            <button
              className="icon-btn"
              title="Save to library"
              aria-label="Save to library"
              onClick={() => saveToLibrary(f)}
            >
              <Library size={13} />
            </button>
          </div>
        ))}
      </div>
      {files.length > 0 && (
        <div
          className="panel-bar"
          style={{ gap: 4, padding: '6px 12px', borderTop: '1px solid var(--line)' }}
        >
          <button
            className="seg"
            title="Import selected"
            disabled={selected.size === 0}
            onClick={() => void importSelected()}
          >
            Import selected
          </button>
        </div>
      )}
    </div>
  );
}
