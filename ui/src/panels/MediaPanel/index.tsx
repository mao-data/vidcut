import { useState } from 'react';
import { ProjectMediaZone } from './ProjectMediaZone.js';
import { LibraryZone } from './LibraryZone.js';

/**
 * Media 分頁：專案媒體／素材庫／素材夾 三區（spec 2026-08-21 §UI；CapCut Space 心智模型）。
 * ⚠️ 本面板內任何操作都不呼叫 useSelection.select()——App.tsx 的「選取跳 Properties」
 * 會把使用者踢出本分頁（那條 effect 是 2026-08-16 版面定案，不改它，改我們自己）。
 *
 * 檔案結構：本檔（分頁殼＋Folder 佔位）＋ ProjectMediaZone.tsx／LibraryZone.tsx 三檔
 * ——單檔一度超過 ~400 行（Task 6 素材庫真身進來後），照計畫的檔案結構原則拆開。
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

function SourceFolderZone() {
  return (
    <div className="panel-body">
      <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
        Source folder zone (Task 7)
      </div>
    </div>
  );
}
