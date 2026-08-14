#!/usr/bin/env bash
# vidcut 驗證關卡的單一進入點——EVIDENCE.md 引用的每個數字都由這支腳本產生。
# 用法：scripts/gauntlet.sh [--fast]   （--fast 只跳過突變測試那一層，其餘全跑）
#
# 註：`--fast` **不會**跳過需要 ffmpeg 的整合測試——`npm test` 那層一律照跑，真 ffmpeg
# 與真 whisper 都會動。這行以前寫成「跳過整合測試與突變」，與程式碼不符（下面只有
# 突變那段被 FAST 擋住）；照著那句話判斷「--fast 沒碰到 ffmpeg 路徑」會得到錯的結論。
#
# ⚠️ 突變測試那層會照著 mutants.json 把產品原始碼故意改壞、跑完該隻再還原，中途工作樹
# 會抖動。這個工作區常有多個 session 並行——**別人在同一個工作樹工作時不要跑完整版**，
# 他們剛好在還原前 commit 就會提交到你的突變體。要跑就開一個獨立 worktree（記得在裡面
# npm install，否則 @vidcut/shared 會 symlink 到主 repo 當前分支，數字量錯對象）。
set -uo pipefail
cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
fail=0
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
check() { if [ "$1" -eq 0 ]; then echo "   PASS"; else echo "   FAIL"; fail=1; fi; }

step "版本記錄"
echo "   node       $(node --version)"
echo "   npm        $(npm --version)"
echo "   typescript $(npx tsc --version | awk '{print $2}')"
echo "   vitest     $(npx vitest --version 2>/dev/null | tail -1)"
echo "   ffmpeg     $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
echo "   source     $(git rev-parse --short HEAD 2>/dev/null || echo 'no git')"

step "型別檢查 (tsc --noEmit ×3 workspaces)"
npm run typecheck >/dev/null 2>&1; check $?

step "Lint (eslint .)"
npm run lint >/dev/null 2>&1; check $?

step "格式 (prettier --check)"
npm run format:check >/dev/null 2>&1; check $?

step "全測試套件"
npm test 2>&1 | grep -E "Tests +[0-9]+ (passed|failed)" | sed 's/^/   /'
npm test >/dev/null 2>&1; check $?

step "UI 覆蓋率"
(cd ui && npx vitest run --coverage 2>&1 | grep -A 6 "Coverage report" | sed 's/^/   /')

step "隨機順序（抓 flaky / 順序相依）"
(cd ui && npx vitest run --sequence.shuffle --sequence.seed=1337 >/dev/null 2>&1); check $?
(cd server && npx vitest run --sequence.shuffle --sequence.seed=1337 >/dev/null 2>&1); check $?

step "突變錨點（--check，秒級：確認每隻 mutant 的 find 仍命中目標）"
node scripts/mutate.mjs --check 2>&1 | sed 's/^/   /'
node scripts/mutate.mjs --check >/dev/null 2>&1; check $?

step "文件引用（斷言型文件不得指向不存在或被忽略的東西）"
node scripts/docs-check.mjs 2>&1 | sed 's/^/   /'
node scripts/docs-check.mjs >/dev/null 2>&1; check $?

step "使用者面字串（產品原始碼不得有中文字串字面值；註解不算）"
node scripts/i18n-check.mjs 2>&1 | sed 's/^/   /'
node scripts/i18n-check.mjs >/dev/null 2>&1; check $?

step "依賴稽核 (npm audit --omit=dev 為執行期；全量含 dev)"
npm audit --audit-level=high 2>&1 | tail -3 | sed 's/^/   /'

step "秘密掃描（追蹤中的檔案不得含 .env 內容）"
SECRET_RE='(sk-[A-Za-z0-9]{20,}|_API_KEY=.+|_SECRET=.+|BEGIN [A-Z ]*PRIVATE KEY)'
# 排除掃描器自己與 lock 檔：前者含這個正則本身，後者只有 integrity 雜湊
if git grep -nIE "$SECRET_RE" -- . ':!scripts/gauntlet.sh' ':!package-lock.json' >/dev/null 2>&1; then
  echo "   FAIL: 疑似秘密"; fail=1
else
  echo "   PASS"
fi

if [ "$FAST" -eq 0 ]; then
  step "突變測試（scripts/mutants.json）"
  # 只跑一次（這是全場最慢的關卡，跑兩次等於雙倍）。綠燈印摘要；紅燈印**全部**壞掉的
  # 那幾隻——舊版固定 `tail -3`，5 隻壞的只會看到 3 隻，剩下的靜默消失。
  mut_out=$(node scripts/mutate.mjs 2>&1); mut_rc=$?
  if [ "$mut_rc" -eq 0 ]; then
    printf '%s\n' "$mut_out" | tail -3 | sed 's/^/   /'
  else
    printf '%s\n' "$mut_out" | grep -E '^\s*(ERROR|SURVIVED):|mutants killed' | sed 's/^/   /'
  fi
  check "$mut_rc"
fi

printf '\n'
[ "$fail" -eq 0 ] && echo "GAUNTLET: 全數通過" || echo "GAUNTLET: 有關卡失敗"
exit "$fail"
