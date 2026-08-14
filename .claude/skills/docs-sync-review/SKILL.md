---
name: docs-sync-review
description: vidcut 專用的文件同步審查。改完程式碼、準備 commit 前使用:按變更類型對照文件矩陣逐份審查,每份給出「已更新/查過無需改」的帶證據結論,最後跑機械閘門。也適用於使用者問「文件有沒有跟上」時。
---

# docs-sync-review — vidcut 文件同步審查

這個 repo 的文件是斷言型的(HANDOFF/CLAUDE.md/README 描述現況,錯一句就會誤導下一個
session)。機械閘門只能驗「可判定」的事;這個 skill 負責剩下的部分:**強迫逐份文件
有意識地過目,並留下可查證的結論**。

## 第 0 步:反幻想條款(全程有效)

- 寫進文件的每個路徑、行號、指令、數字,寫之前先用 grep/ls/實跑取證。**禁止憑記憶寫。**
- 「查過無需改」也是結論,必須附證據(查了哪份、grep 了什麼、為何不用改)。
- 禁止未來式宣稱(還沒做的東西不進描述現況的文件;前瞻內容只進 ROADMAP/specs)。
- 不得弱化既有限定詞(例:karaoke「預覽略厚、匯出正確」的限定語是產品事實)。
- 文件數字必須來自最終一次實跑,不引用中途或歷史 run 的數字。

## 第 1 步:變更分類

`git diff --stat` + `git status --short`(只看自己動過的檔案),按路徑歸類到下表。
一個 commit 可能命中多列。

## 第 2 步:文件矩陣(每命中一列,逐項過目)

| 變更類型 | 必查文件與動作 |
|---|---|
| `shared/src/types.ts` 的 Command variant、`server/src/commands.ts` | CLAUDE.md 鐵則三步:第三步 `server/src/mcp.ts` 的 registerTool+instructions 有沒有跟上(`server/test/mcp-docs-sync.test.ts` 會抓漏註冊,但描述語意要人看) |
| `server/src/mcp.ts`(工具描述/instructions/schema) | snapshot 閘門必紅:`npm test -w @vidcut/server`。**先讀 diff 確認新描述屬實**,再 `npm test -w @vidcut/server -- -u mcp-surface-snapshot` 更新;順手檢查 README 九組工具表是否仍準確 |
| `ui/src`/`server/src`/`shared/src` 新增或刪除原始檔 | HANDOFF.md 檔案職責表補/刪一行(`scripts/docs-check.mjs` 檢查 4 會紅,但職責敘述的正確性要人寫) |
| 對外可見的行為/功能(UI 可見變化、輸出格式、CLI) | README.md 敘述是否變假;動了就 **README.zh-TW.md 雙語同步**(brand 承諾:英文為主、繁中並行) |
| verify 腳本、瀏覽器量測、測試基礎設施 | `.claude/rules/ui-verification.md`;wysiwyg 相關則 `.claude/rules/wysiwyg.md` |
| 完成了 ROADMAP/調研提案裡列的項目 | `docs/ROADMAP.md` 與 `docs/research/` 對應項對帳(標完成/劃掉) |
| 跑過 gauntlet 的功能性變更 | EVIDENCE.md 追加一節:行為→測試對映、gauntlet 數字、綁 commit SHA、過程中的發現(含失敗)如實記 |
| 動到 git 流程、open-core 邊界、鐵則本身 | CLAUDE.md 對應段落;**Pro 能力表是閘門不是參考資料**,改它需要使用者明確拍板 |
| cloud/商業線相關 | 只在 cloud-p0 分支處理(main→cloud-p0 合併後檢查 `CLAUDE.cloud.md`/`HANDOFF.cloud.md` 哪句過期);main 上不寫 cloud 敘述 |

## 第 3 步:機械收尾(全部實跑,貼輸出)

1. `node scripts/docs-check.mjs` — 引用完整性+HANDOFF 反向覆蓋
2. `npm test -w @vidcut/server` — 含 MCP 面 snapshot 閘門與 mcp-docs-sync
3. 動過 README 時:兩份 README 逐節人工對照(結構與宣稱一致,允許語言慣用差異)
4. 功能性變更收尾照 CLAUDE.md 慣例跑 `bash scripts/gauntlet.sh`(期間不 commit)

## 第 4 步:輸出格式

逐文件一張表:

| 文件 | 結論 | 證據 |
|---|---|---|
| HANDOFF.md | 已更新(+2 行職責) | diff 摘要 |
| README.md | 查過無需改 | 「本次無對外行為變更;grep 功能敘述無涉及」 |
| … | … | … |

沒有這張表,審查不算完成。

## 已知限制(誠實聲明)

機械閘門+本流程擋得住「忘了改」與「改了沒人看」;擋不住「看了但寫錯」——
語意正確性的最後防線是執行本 skill 的人對第 0 步的誠實。
