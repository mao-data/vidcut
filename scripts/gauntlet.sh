#!/usr/bin/env bash
# vidcut 驗證關卡的單一進入點——EVIDENCE.md 引用的每個數字都由這支腳本產生。
# 用法：scripts/gauntlet.sh [--fast]   （--fast 跳過需要 ffmpeg 的整合測試與突變）
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
  node scripts/mutate.mjs 2>&1 | tail -3 | sed 's/^/   /'
  node scripts/mutate.mjs >/dev/null 2>&1; check $?
fi

printf '\n'
[ "$fail" -eq 0 ] && echo "GAUNTLET: 全數通過" || echo "GAUNTLET: 有關卡失敗"
exit "$fail"
