# 发布检查清单 · dsh-connect-doubao

> 面向人。按顺序执行，每一步都给了**预期输出**，方便你比对。
> 全程约 10 分钟操作 + **必须等满 24 小时**（见步骤 7，硬性规则）。

## 0. 先跑这个

```powershell
cd E:\project\新建文件夹\dsh-connect-doubao
node scripts\publish-checklist.mjs
```

**看到 `READY TO SUBMIT` 才继续。** 它只做本地只读检查，不会 commit / push / publish。

---

## 1. 确认暂存清单干净

```powershell
git status --short
```

预期：**71 个文件全部是 `A `（新增）**，且满足

- `docs/assets/*.png` 两张图都在
- **没有** `lib/`、`node_modules/`、`*.log`、`*.tgz`、`*.bak`（已被 `.gitignore` 挡掉）

## 2. 首次提交

```powershell
git branch -M main
git commit -m "Initial release: DSH Connect Doubao"
```

预期输出：

```
[main (root-commit) abc1234] Initial release: DSH Connect Doubao
 71 files changed, ...
```

> 默认分支是 `master`，上面第一条改成 `main` 与 GitHub 一致。

## 3. 再跑一次闸门

```powershell
node scripts\publish-checklist.mjs
```

这次应输出 **`17/17 通过` + `READY TO SUBMIT`**。

## 4. 在 GitHub 建仓并推送

浏览器：新建仓库

- 名称：`dsh-connect-doubao`
- ⚠️ **不要**勾选自动创建 README / LICENSE / `.gitignore`（会与本地冲突）

然后：

```powershell
git remote add origin https://github.com/Wahwayhale/dsh-connect-doubao.git
git push -u origin main
```

预期：

```
Enumerating objects: 71, done.
To https://github.com/Wahwayhale/dsh-connect-doubao.git
 * [new branch]      main -> main
```

## 5. 打 topic（市场硬性要求 R6）

仓库页面右侧 → **Topics** → 添加 `dsh-plugin`。

⚠️ 不打这个 topic，PR 虽然能开，但维护者会按「不完整」处理。

## 6. 发布 npm（可选但推荐）

```powershell
npm publish --access public
```

前提：步骤 4 已完成 —— 否则 npm 页面上的源码链接会指向不存在的仓库。

## 7. ⏳ 等满 24 小时（硬性规则 R4）

```
⚠️ 这一步不能跳过。

市场 CI 会检查「仓库创建时间 ≥ 1 天」，用来过滤「PR 前几分钟才建好」的抢注仓库。
这是对提交质量的判断，不是硬门槛，但 CI 会直接拦下。
```

昨天建仓 → 今天提交 PR。间隔不足 24 小时的话，等满再提。

## 8. 提 PR

```powershell
git clone https://github.com/<你的账号>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-connect-doubao

mkdir data\plugins -Force
copy "E:\project\新建文件夹\dsh-connect-doubao\awesome-dsh-plugin-submission\Wahwayhale__dsh-connect-doubao.yml" `
      "data\plugins\Wahwayhale__dsh-connect-doubao.yml"

git add data\plugins\Wahwayhale__dsh-connect-doubao.yml
git commit -m "Add dsh-connect-doubao"
git push origin add-dsh-connect-doubao
```

然后浏览器打开你的 fork → **Compare & pull request** → 提到上游。

---

## PR CI 四步分别失败时改什么

CI 顺序是固定的（先查条数，最后才联网），失败信息会直接告诉你改什么。

| 失败步骤 | 报错关键词 | 改什么 |
| --- | --- | --- |
| ① 条数 | `too many entries` | 一个 PR 最多 3 条。我们只提交 1 个文件，确认没有手抖多提交 |
| ② manifest | `dsh.bundle` not declared | `package.json` 的 `dsh.bundle.patch` 必须在，且仓库根有 `cordis.patch.yml` —— 我们都有，**别动** |
| ③ 仓库年龄 | `repository is too new` | 不是配置问题，**等满 1 天**再重跑 CI |
| ④ lint / 构建 | `awesome-lint` / 站点构建失败 | 看具体行号；常见是分隔符（必须是 `__`）或双语缺一侧 |

**修复方式**：在同一分支改完 `git push`，CI 自动重跑 —— **不需要重开 PR**。

---

## 万一要退回

| 想退回什么 | 怎么做 |
| --- | --- |
| 撤回已提交的 commit（还没 push） | `git reset --soft HEAD~1`，文件回到暂存区，可重新编辑 |
| 退回暂存 | `git reset`（文件改动保留，只是取消暂存） |
| 退回文件内容 | `git checkout -- <文件>`（⚠️ 丢弃该文件的本地改动） |
| 关闭 PR | GitHub PR 页面 → Close，**不需要** revert commit |

> 一旦 `git push` 且仓库已公开，commit 历史就公开了。
> 此时改历史需要 rewrite（`git rebase` / `force push`），只在**自己独占的仓库**上做，
> 若已有他人 fork 则**不要** force push。

---

## 关键信息速查

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/Wahwayhale/dsh-connect-doubao` |
| npm 包 | `dsh-connect-doubao` |
| 投稿路径 | `data/plugins/Wahwayhale__dsh-connect-doubao.yml`（**双下划线**） |
| 分类 | `model` |
| 必需 topic | `dsh-plugin` |
| 许可证 | MIT，`Copyright (c) 2026 Wahwayhale` |
