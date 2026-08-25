import { useState } from 'react';

/**
 * Media 分頁：專案媒體／素材庫／素材夾 三區（spec 2026-08-21 §UI；CapCut Space 心智模型）。
 * ⚠️ 本面板內任何操作都不呼叫 useSelection.select()——App.tsx 的「選取跳 Properties」
 * 會把使用者踢出本分頁（那條 effect 是 2026-08-16 版面定案，不改它，改我們自己）。
 */
export function MediaPanel() {
  const [zone, setZone] = useState<'project' | 'library' | 'source'>('project');
  return (
    <div className="panel-col" style={{ minWidth: 0 }}>
      <div className="panel-bar" style={{ gap: 4 }}>
        <button
          className={`seg${zone === 'project' ? ' on' : ''}`}
          title="Project media"
          onClick={() => setZone('project')}
        >
          Project
        </button>
        <button
          className={`seg${zone === 'library' ? ' on' : ''}`}
          title="Library"
          onClick={() => setZone('library')}
        >
          Library
        </button>
        <button
          className={`seg${zone === 'source' ? ' on' : ''}`}
          title="Source folder"
          onClick={() => setZone('source')}
        >
          Folder
        </button>
      </div>
      {zone === 'project' && <ProjectMediaZone />}
      {zone === 'library' && <LibraryZone />}
      {zone === 'source' && <SourceFolderZone />}
    </div>
  );
}

// 三區最小可測殼——真身留給 Task 5–7。
function ProjectMediaZone() {
  return (
    <div className="panel-body">
      <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
        Project media zone (Task 5)
      </div>
    </div>
  );
}

function LibraryZone() {
  return (
    <div className="panel-body">
      <div className="panel-bar" style={{ gap: 4 }}>
        <input placeholder="Search library" style={{ flex: 1, minWidth: 0 }} />
      </div>
      <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
        Library zone (Task 6)
      </div>
    </div>
  );
}

function SourceFolderZone() {
  return (
    <div className="panel-body">
      <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
        Source folder zone (Task 7)
      </div>
    </div>
  );
}
