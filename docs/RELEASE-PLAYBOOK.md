# 发版流程与「市场不更新」排查手册

> 这份文档记录 0.6.0 发版时踩过的坑。下次发版直接照着走，别再花两天排查。

---

## 一、发版四步（顺序不能错）

### 1. 发布 npm

```powershell
cd E:\project\新建文件夹\dsh-connect-doubao
npm publish --registry=https://registry.npmjs.org/ --access public
```

**必须显式带 `--registry`。** `~/.npmrc` 里的 registry 指向 `registry.npmmirror.com`（只读镜像），不带这个参数就会报 `ENEEDAUTH: need auth`，因为发布请求打到了镜像站。

### 2. 推送 GitHub

```powershell
git push origin main
```

### 3. 提市场 PR

改 `awesome-dsh-plugin-submission/Wahwayhale__dsh-connect-doubao.yml` 的 `description`，然后：

```powershell
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b update-xxx
# 覆盖 data/plugins/Wahwayhale__dsh-connect-doubao.yml（去掉本地文件的注释头）
git diff --stat          # 应该只有几行
git add data/plugins/Wahwayhale__dsh-connect-doubao.yml
git commit -m "..."
git push origin update-xxx
```

**关键：推到自己的 fork（`Wahwayhale/awesome-dsh-plugin`），不要直接推上游。** 上游没有写权限，会 403。

然后开 PR：

```powershell
# fork 上推完，用 API 或网页开 PR
https://github.com/Wahwayhale/awesome-dsh-plugin/pull/new/<branch>
```

### 4. 等 CI

`PR check` 工作流共 15 步：Stale-fork guard → 条目路径 → README 一致性 → **awesome-lint** → 各类测试 → Build。

全绿后维护者合并。

---

## 二、市场条目规则（踩过的坑）

| 规则 | 说明 |
| --- | --- |
| **禁止 marketing 词** | `description.en` 里不能有 `free` 之类。`watermark-free` 被 `validate-submission.mjs` 拦下，改成 `the original file over the watermarked variant` 才过 |
| **没有 version 字段** | 条目 YAML 只有 `url` / `name` / `category` / `description` / `icon` |
| **`description.en` 必须以句号结尾** | |
| **含 `: ` 的值必须加引号** | 否则 YAML 解析失败 |

提交前必跑：

```bash
node scripts/validate-submission.mjs     # 20 项，要看到 OK
node scripts/publish-checklist.mjs       # 18 项，要看到 READY TO SUBMIT
```

---

## 三、「市场显示旧版本」排查顺序

### 第一步永远是：重启 DSH

这次卡了两天，根因就是本地 dshmarket 的内存缓存没刷新。**先重启，再查别的。**

### 各层数据源

| 层 | 检查方式 | 0.6.0 时的实际值 |
| --- | --- | --- |
| npm | `registry.npmjs.org/dsh-connect-doubao` → `dist-tags.latest` | 0.6.0 ✓ |
| 市场站点 | **`https://awesome-dsh-plugin.com/plugins.json`** | 0.6.0 ✓ |
| 本地 dshmarket | `GET http://127.0.0.1:<port>/dsh-market/registry` → `registry.updated` | 曾停在 11-11 |
| 本地已装 | `GET .../dsh-market/installed` | `"dsh-connect-doubao": "link:E:/project/..."` |

**注意市场站点的域名**：dshmarket 的 registry 指向 `awesome-dsh-plugin.com`，不是 `awesome-dsh-plugin.github.io`。两个域名数据可能不同步，查错地方会得出错误结论。

### 关键教训

1. **`~/.dsh/plugin-console-market-index-cache.json` 不是 dshmarket 的缓存。** 它停在 10-10，搜插件名 0 命中，删了没用——那是另一个插件的文件。
2. **dshmarket 的目录缓存在内存里**，没有刷新按钮，TTL 到期也不主动重拉。只有重启进程才会重新拉。
3. 卡片上的版本号来自 `CatalogVersionMark({ version: p.version })`，即「目录记录的安装版本」。dshmarket 自己的文案就承认了：`catalogVersionUndated: "目录记录的安装版本；可能滞后于项目的新发行"`。
4. 本地是 `link:` 安装时，`/dsh-market/installed` 返回 `link:E:/...` 而非版本号，所以只能回退显示目录值。

---

## 四、GitHub 操作注意

- 本机**没有独立安装 Git**，用的是 DSH 沙箱内的临时副本（无凭据助手）。
- `git clone` 报 403 时：加 `-c credential.helper=` 禁用助手，匿名克隆正常。
- Windows 凭据管理器里有 `git:https://github.com`（用户 `Wahwayhale`），但那个 token 是经典 PAT 且**权限不足**——推上游 403，推 fork 可以。
- 用 API 创建 PR 时，PowerShell 的 `Get-Content -Raw` 返回带 PSPath 属性的对象，会导致 `422 Invalid request`。必须用 `[System.IO.File]::ReadAllText()`。
- GitHub 匿名 API 限流 60 次/小时。查 CI 状态时用 token 认证可绕过。

---

## 五、编辑文件注意（换行符）

仓库里不同文件的换行符不一致：

| 文件 | 换行符 |
| --- | --- |
| `README.md` / `README.en.md` / `CHANGELOG.md` | LF |
| `src/*.ts`（大部分） | LF |
| `package.json` / `src/doubao-catalog.ts` | **CRLF** |

用 Python 写文件时不指定 `newline='\n'` 会写成 CRLF，导致 diff 变成整个文件重写（几千行）。

**改完必须 `git diff --stat` 检查**，行数暴涨就是换行符变了。

---

## 六、插件源码结构

- `src/*.ts` 是源码，`lib/` 是 `tsdown` 构建产物（**已 gitignore**，发版时 `prepack` 自动构建）。
- 改代码要改 `src/`，然后：

  ```bash
  ./node_modules/.bin/tsdown
  ```

- 构建会重新计算 chunk 哈希文件名（如 `doubao-quota-Bq-V97h9.js` → `doubao-quota-DeHMQkrq.js`），旧的会被删掉。
- `image-models.json` 是每台机器本地生成的 overlay，**不入库**。代码里缺省值写死 Seedream 5.5，用户装完就能用。

---

## 七、本地开发模式的副作用

`package.json` 里是 `link:E:/project/新建文件夹/dsh-connect-doubao`，好处是改代码即时生效，代价是：

- `/dsh-market/installed` 拿不到版本号
- 市场卡片显示的是目录记录值，可能滞后

**这不影响功能**，你跑的永远是本地最新代码。只有想验证「用户从市场装会拿到什么」时，才需要临时换成 npm 版本安装。
