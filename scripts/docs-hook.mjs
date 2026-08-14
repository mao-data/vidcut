#!/usr/bin/env node
/**
 * PostToolUse hook:編輯特定檔案時提醒文件同步義務(docs-sync-review skill 的觸發器)。
 *
 * 設計原則:
 * - 只提醒、永不阻擋(一律 exit 0);砸鍋也不能影響 session(整包 try/catch)。
 * - 決定性、零依賴、毫秒級;無關檔案零輸出(吵的 hook 會被習慣性忽略)。
 * - 提醒透過 hookSpecificOutput.additionalContext 注入,這是 Claude Code hooks
 *   保證送達模型的路徑(exit 0 的裸 stdout 不保證進 context)。
 *
 * 佈線:專案 .claude/settings.json(在 ai-video-cut 內起的 session)與工作區根
 * .claude/settings.json(在 gi_+repo 根起的 session;machine-local,不進 git,
 * 換機要照 HANDOFF 重佈)。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const fp = input?.tool_input?.file_path;
  if (typeof fp !== 'string') process.exit(0);
  const abs = resolve(fp);
  const rel = relative(repoRoot, abs);
  // repo 之外的檔案與 repo 內的隱藏路徑(.claude 等)都不歸這個 hook 管
  if (rel.startsWith('..') || rel.startsWith('.')) process.exit(0);

  const reminders = [];

  if (rel === 'server/src/mcp.ts') {
    reminders.push(
      'mcp.ts 已被 MCP 面 snapshot 鎖定(server/test/mcp-surface-snapshot.test.ts)。' +
        '跑 `npm test -w @vidcut/server`;紅了先讀 diff 確認新描述屬實,再用 ' +
        '`npm test -w @vidcut/server -- -u mcp-surface-snapshot` 更新。' +
        '描述與 instructions 的語意同步是 CLAUDE.md 鐵則;commit 前建議跑 docs-sync-review skill。',
    );
  }

  const inSrc = /^(ui|server|shared)\/src\//.test(rel);
  const isSource = /\.(ts|tsx|css|py)$/.test(rel) && !/\.test\.|\.d\.ts$/.test(basename(rel));
  if (inSrc && isSource && existsSync(abs)) {
    let tracked = true;
    try {
      execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', rel], {
        stdio: 'ignore',
      });
    } catch {
      tracked = false;
    }
    if (!tracked) {
      reminders.push(
        `新原始檔 \`${rel}\` 尚未被 HANDOFF.md 檔案職責表覆蓋的話,` +
          '`node scripts/docs-check.mjs` 會紅(檢查 4)。補一行職責敘述,' +
          'commit 前建議跑 docs-sync-review skill。',
      );
    }
  }

  if (rel === 'README.md' || rel === 'README.zh-TW.md') {
    const other = rel === 'README.md' ? 'README.zh-TW.md' : 'README.md';
    reminders.push(`README 是雙語並行(brand 承諾):確認 \`${other}\` 是否需要同步這次改動。`);
  }

  if (reminders.length) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `[docs-sync] ${reminders.join('\n[docs-sync] ')}`,
        },
      }),
    );
  }
} catch {
  // 提醒器永不擋路
}
process.exit(0);
