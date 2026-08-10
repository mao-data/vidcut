# Contributing to vidcut

Thanks for your interest! Issues and PRs are welcome.

## Before you start

- Read [`CLAUDE.md`](CLAUDE.md) — it is the map of this codebase's invariants
  (the WYSIWYG guarantee, the command-layer iron rules, how to run the test
  gauntlet). PRs that break an invariant documented there will be asked to fix it.
- Run `bash scripts/gauntlet.sh` before opening a PR. Green is the baseline.

## Contributor License Agreement (CLA)

vidcut is licensed under **AGPL-3.0-only**, and its maintainer (mao-data) also
distributes commercial editions of vidcut. So that the project can keep doing
both, we ask every contributor to agree to the following lightweight CLA:

> By submitting a contribution (pull request, patch, or code suggestion) to this
> repository, you agree that:
>
> 1. You are the author of the contribution and have the right to submit it.
> 2. You license your contribution to the project under **AGPL-3.0-only**.
> 3. You additionally grant mao-data a perpetual, worldwide, non-exclusive,
>    royalty-free right to relicense and use your contribution as part of
>    vidcut, including in commercial, non-AGPL editions.
>
> You retain the copyright to your contribution.

Indicate agreement by adding this line to your PR description:

```
I agree to the vidcut CLA in CONTRIBUTING.md.
```

PRs without this line cannot be merged.

## 中文摘要

vidcut 採 **AGPL-3.0-only** 授權，維護者同時發行商業版。為了讓兩者並存，所有貢獻
需同意上述輕量 CLA：你的貢獻以 AGPL-3.0 授權給專案，並額外授權 mao-data 可將其
用於商業版本；著作權仍屬於你。在 PR 說明中加上
`I agree to the vidcut CLA in CONTRIBUTING.md.` 即表示同意。

送 PR 前請先跑 `bash scripts/gauntlet.sh`，並讀過 [`CLAUDE.md`](CLAUDE.md) 裡的
不變量（「預覽即成品」、命令層鐵則）。
