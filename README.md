# DSH Connect Doubao

> 把**豆包（Doubao）账号**接入 DeepSeek Harness：**对话模型**与
> **「工作任务」模型**（2.1 Lite / 2.1 Pro / 自动，走会员付费额度）、**Seedream 生图**，
> 外加一块**只读**额度看板（5 小时限额 / 周额度 / 活动赠送额度，含重置倒计时）。
> 登录方式只有一种：**浏览器扫码登录一次**。会话密封在本机：Windows 用 DPAPI（当前用户作用域），
> macOS / Linux 用每用户密钥的 AES-256-GCM。

[![npm version](https://img.shields.io/npm/v/dsh-connect-doubao.svg)](https://www.npmjs.com/package/dsh-connect-doubao)
[![license](https://img.shields.io/npm/l/dsh-connect-doubao.svg)](./LICENSE)
[![dshfind](https://img.shields.io/badge/dshmarket-dshfind-blueviolet)](https://dshfind.dev)

![豆包卡片：额度面板与模型清单](docs/assets/dsh-connect-doubao-quota-card.png)

---

## ⚠️ 前置条件（必读）

**登录方式只有一种：浏览器扫码登录一次。不需要安装或登录豆包桌面客户端。**

点卡片里的「重新登录」，插件拉起一个独立的 Chromium 窗口打开豆包登录页；你扫码（或手机号
验证）之后它通过 CDP 取回会话 cookie，并密封到 `~/.dsh/doubao-credentials-browser.dpapi`
（Windows 用 DPAPI，macOS / Linux 用 AES-256-GCM，见下「平台支持」）。整个流程只在登录
那一刻需要人，之后都是纯 HTTP 调用。

| 要求 | 说明 |
| --- | --- |
| **扫码登录一次** | 未登录 → 卡片显示「未登录」，provider 不可用 |
| **Windows / macOS / Linux** | Windows 密封用 DPAPI；macOS / Linux 用 `~/.dsh/doubao-credential-key`（0600）做 AES-256-GCM 密封 |
| 本机有 Chrome 或 Edge | 登录窗口就是它，装在默认路径即可；非默认路径可用 `DSH_DOUBAO_BROWSER` 指定 |
| 有可用订阅额度 | 免费账号也能连，但配额很小 |

没有登录态时插件会明确报错（「还没有浏览器登录态。请在豆包卡片里点「重新登录」扫码一次。」），
而不是静默失败。

---

## 功能特性

- **两组豆包模型** —— 对话模式两条（快速 / 2.1 Turbo·专家）与「工作任务」模式三条
  （2.1 Lite `seed-lite-7b`、2.1 Pro `5`、自动 `9`）。任务模型走的是**会员付费额度**，
  选中即自动切到任务模式的完整请求形态。
- **生图（Seedream 5.5）** —— 模型选择器里选「豆包 生图」，回复即以 Markdown 图片返回真实生成图，可直接下载落盘。2026-11-02 实测端到端通过。
- **推理强度三档** —— 低 / 中 / 高，对应上游 `reasoning_effort` 实测值 **3 / 4 / 5**。
- **深度思考默认开启** —— 不再需要额外开关：非「工作任务」模型每轮发 `need_deep_think: 3`，任务模型沿用抓包到的真实形态 `10001`。`DSH_DOUBAO_DEEP_THINK=0` 可关掉。
- **只读额度面板** —— 5 小时限额、周额度、活动赠送额度三条进度条，各带**重置倒计时**；设置面板里手动刷新 + 5 分钟自动刷新。
- **模型勾选清单** —— 勾选的条目会出现在 DSH 的模型选择器中，请求时按 `model_item_key` 指定模型。
- **账号状态行** —— 区分「已登录 / 未登录 / 登录信息读不出来」等状态，各自给出不同的处置建议。
- **独立 loopback shim** —— 对话请求走一个只监听 `127.0.0.1` 的本地端点，带每进程共享密钥，任何非本机请求一律拒绝。
- **命令行诊断** —— `doctor` / `probe`，不消耗推理额度即可体检整条链路。

---

## 已验证

**验证环境**（一次具体的真机条件，不是"所有环境都可用"的承诺）：

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows x64 |
| 豆包电脑版 | 2.31.4（已登录） |
| DeepSeek Harness | 0.2.0-rc.2（桌面版） |
| Node.js | 24.18.1（宿主内） |

### 真机截图证明（用户实拍）

- ✅ **卡片挂在设置左侧导航里** —— 设置面板左栏出现「豆包」一级导航项，点击后右侧显示本卡片。
- ✅ **额度面板读到真实数据** —— 截图里可见 `标准套餐`、`5 小时限额 已用 0% · 2h 17m 后重置`、
  `周额度 已用 9% · 5d 21h 后重置`、`账号状态: 已登录`、`每 5 分钟自动刷新`、配置目录路径。
- ✅ **模型清单六个条目全部渲染** —— 豆包 快速 / 2.1 Lite（`0921 新版`）/ 2.1 Turbo（`专家`）/
  2.1 Pro / 2.1 Turbo（`即将下线`）/ 自动，角标与桌面包一致，计数显示 `已启用 6 ↑`。
  > 这张截图来自 **0.4.0**：当时工作任务模型只被渲染出来、还没接通，徽章取客户端原名。
  > 0.4.1 起它们带 `工作任务` 徽章并且真的能对话，截图尚未重拍。
- ✅ **模型选择器里出现「豆包（Doubao）」分组** —— 六个条目逐一列出。
  这是 **provider 注册成功 + catalog 生效** 的端到端证据。
- ✅ **勾选交互可用** —— 每行一个勾选框，配 `刷新` / `全选` / `全不选` / `保存` 四个按钮。

![模型选择器中的豆包条目](docs/assets/dsh-connect-doubao-settings-section.png)

### 代码级 / 抓包级证据（非截图）

- `doctor` 五项检查全绿：凭据从本机密封会话读出 29 个 cookie 且 9/9 必需会话 cookie 齐备、账号被上游接受、
  shim 绑定回环端口且错误 bearer 返回 401、三个额度窗口可读、模型发现开放 6 个。
- 推理强度 低=3 / 中=4 / 高=5：由**抓取客户端切换档位时重新序列化的配置 diff**读出，
  并由客户端配置里的 `reasoning_effort_config` 独立确认。
- 请求体带 `model_item_key` 与 `reasoning_effort`：抓包确认。

### 这不代表什么

以上只对**上述那台机器、那个账号、被验证的那个时间点**成立。
**不构成任何兼容性保证** —— 请务必读下面的「已知限制」。

---

## 模型目录

**清单不是硬编码的，是照抄豆包客户端菜单。** 客户端每次刷新菜单都会把它写进
`Default/Preferences` 的 `saman.local_storage_for_web['frontend-request-cache']`
（`_DesktopActionBarBriefListRequestCacheDataV1.data.modeSelectData`），插件读这里，
所以豆包上新模型、调价、改档位都会自动出现，不需要等插件发版。IndexedDB 只在 Preferences
尚未写入时兜底。

豆包把模型按**模式**分组（`default_mode`：`1` = 对话，`3` = 工作任务）。当前这台机器读到的：

| 名称 | `model_item_key` | 模式 | 倍率标签 | 思考档位 |
| --- | --- | --- | --- | --- |
| 豆包 快速 | `0` | 对话 | — | 不可推理 |
| 豆包 2.1 Turbo | `3` | 对话 | — | 低 / 中 / 高 |
| 豆包 2.1 Pro | `5` | 工作任务 | 0.65x | 低 / 中 / 高 |
| 自动 | `9` | 工作任务 | 小额免费 | 低 / 中(8) / 高 |
| 豆包 2.1 Lite | `seed-lite-7b` | 工作任务 | 限时优惠 0.01x | 低 / 中 / 高 |
| DeepSeek V4 Pro | `person-deepseek-v4-pro-ga-260813` | 工作任务 | 0.46x | 低 / 中 / 高 / 极高 / 最高 |
| DeepSeek V4.1 Flash | `person-deepseek-v4-1-flash-261017` | 工作任务 | 限时优惠 0.01x | 低 / 中 / 高 / 极高 / 最高 |
| Kimi K3 | `person-kimi-k3-261111` | 工作任务 | 1.48x | 低 / 中 / 高 / 极高 / 最高 |
| Kimi K3.1 Pro | `person-kimi-k3-1-pro-261111` | 工作任务 | 0.95x | 低 / 中 / 高 / 极高 / 最高 |
| Kimi K3.1 Pro 高速 | `person-kimi-k3-1-pro-highspeed-261111` | 工作任务 | 1.44x | 低 / 中 / 高 / 极高 / 最高 |
| GLM 5.3 | `person-glm-5-3-261111` | 工作任务 | 0.80x | 低 / 高 / 最高 |
| GLM 5.3 Flash | `person-glm-5-3-flash-261111` | 工作任务 | 0.08x | 低 / 高 / 最高 |
| 豆包 生图（Seedream 5.5） | `image-gen` | 别名 | — | 低 / 中 / 高 |

> **倍率是客户端菜单的原始文本，只作展示。** 本插件不参与计费，也无法核对实际扣费；
> `限时优惠 0.01x` / `小额免费` 是活动标签，卡片上用描边样式与常价区分。
> 这份表会随客户端菜单变化，以上是 2026-11-12 实测结果。

**思考档位是逐模型的，不是统一三档。** 菜单的 `reasoning_effort_config.option_list` 每个模型
各写一份：GLM 只有 低/高/最高（3/5/7），2.1 Lite 是 低/中/高（3/4/5），「自动」甚至把「中」写在
序号 8 上（所以档位顺序按菜单原序保留，不能按数值排序）。插件按模型自己的阶梯渲染并生成
`thinkingLevelMap`；**实线 = 已在真实请求中验证（3/4/5），虚线 = 仅菜单声明（6 极高 / 7 最高）**。

**「工作任务」模型为什么能用。** 执行侧本来是豆包客户端进程内的 CUA 运行时（`tasks-mode-resource`
+ `sbox`），外部客户端注册不进去，每一轮必然 `710010702`。但 CUA 进程并非必需——服务端真正等的只是
三条 HTTP 应答：

```
POST /alice/office/tool_local/msg/ack               # 轮询本地指令
POST /alice/office/tool_local/upload_command_result  # 回传执行结果
POST /alice/office/tool_local/msg/complete           # 标记该指令完成
```

服务端按 `${unique_key}:${device_id}:${aid}:message:${seq}` 顺序下发（`seq = 0,1,2,…`）：
`command: 6003`（`cmd_call`）需回传结果，`command: 6004`（`agent_finished`）表示本轮结束。
插件在流式生成期间并发跑应答器把这些走完，于是任务回合不再落到 `710010702`。**实测 2026-11-05 通过。**

> ⚠️ **`msg/ack` 必须单条查询。** `{ msg_ids: [0,1,2,3,4,5,6] }` 会整体失败并返回
> `{"code":710010702,"msg":"系统错误"}`——批里只要含一个服务端尚未生成的 `seq`，整批就废。
> 这是逆向时最容易踩的坑，`tests/` 里没有钉它（需要真实上游才能复现）。

**深度思考开关默认打开**（2026-11-07 起）：非「工作任务」模型每轮发 `need_deep_think: 3` 与
`ext.use_deep_think: "3"`；「工作任务」模型（2.1 Lite / Pro / 自动）沿用官方客户端抓到的真实
形态 `10001`。设 `DSH_DOUBAO_DEEP_THINK=0` 可恢复成不思考的普通回合。**档位始终只由
`reasoning_effort` 携带，与开关是两个独立的轴。**

「豆包 快速」**不参与思考**：深度思考全开、档位拉到高，它的回复仍是 `thinking: false`，流里也没有
`10040` 思考容器。所以它被标记为不可推理，模型选择器不再给它显示低/中/高。

> **思考过程为什么看不见**：开关打开后服务端确实在思考（响应里有 `10040` 思考容器和 `10091`
> 计时块），但**推理正文不下发**。2026-11-07 用官方客户端抓包对照确认：思考容器的子块只有一个
> `summary: "正在思考"`，正文块里只有正式答案。这是接口限制，不是插件丢内容。
> 插件的 `collectBlocks` 仍按 `parent_id` 把思考子块与答案分开，shim 也仍以
> `reasoning_content` 转发——服务端哪天真的开始下发，客户端不需要改动就能看到。

---

## 生图（技能轴，与模型轴正交）

豆包把「能力」做成 **skill**，走的是**同一个** `/chat/completion` 端点 —— 客户端里没有独立的文生图 HTTP 接口
（唯一的生成端点 `/creativity/canvas/exec` 是图片编辑器：抠图 / 扩图 / 分层，不是文生图）。

| 字段 | 值 |
| --- | --- |
| 位置 | `ext.input_skill`（**JSON 字符串**） |
| 内容 | `{"skill_id":"3","skill_type":3,"variables":{}}` |
| 关系 | `skill_id` 就是 `skill_type` 的十进制字符串；普通对话是 `"0"`/0 |
| 响应 | `block_type: 2074` → `content.creation_block.creations[].image.{image_ori,image_preview,image_thumb}` |
| 模型 | `placeholder.description` 显示 **Seedream 5.0 Flash** |

技能全表（客户端枚举原样抄录，非推测）：`0` 自由对话、`2` 写作、`3` 生图、`4` 搜索、`5` 翻译、
`6` 阅读、`7` 网页、`8` 深度搜索、`9` 音乐、`11` 教育、`13` 代码执行、`16` 代码助手、`17` 视频、`18` PPT。

本插件目前只接了 **生图**：模型选择器里的「豆包 生图（Seedream 5.5）」是 DSH 侧的能力别名
（`image-gen`，**不是** `model_item_key`），选中后 shim 发一条普通对话轮并带上 `input_skill: imageGen`，
再把返回的图片以 `![…](url)` 追加到正文。

**四个实测细节**：

- **取无水印原图**：同一次生成，流里同时带 `image_ori`（右下角有「豆包AI生成」）和
  `image_ori_raw`（原图）。插件优先取 `image_ori_raw`，取不到才回落 `image_ori`，
  所以账号没开无水印档位时行为不变、不会报错。
- **自动补「生成图片：」前缀**：桌面客户端靠 `chat_ability.ability_param.reply_message_format`
  改写正文，外部客户端没有这个钩子，服务端会把请求当普通对话回答。`withImagePrefix()`
  补上同样的改写：已有前缀不重复加，普通对话完全不受影响。
- **只把用户那句话发出去**：一轮请求里除了用户描述，还夹着开发者提示、运行时快照、
  技能目录、MCP 列表等机器块。插件按「长度 ≤600 字符、不以 `<` 开头、不含已知框架标记」
  筛出真正的描述，否则豆包会把 `turn 1 step 1` 这类框架文本当成画面内容画进去。
- 图片 URL 的签名有效期极长（抓到的 `x-expires` 在 2037 年），但服务端会把 `.jpeg` 结尾的 URL
  实际返回 **PNG 字节** —— 落盘时按内容判断格式，别信扩展名。

验证脚本：`node scripts/verify-imagegen.mjs`（会真实消耗生图额度）。

---

## 模型清单是自动发现的

**插件不再硬编码模型表。** 桌面客户端把服务端下发的 `menuConfV2` 存在自己的 IndexedDB 里，
本插件直接读那份缓存 —— 所以豆包上线新模型后，**不需要等插件更新**就会出现在 DSH 里。

- 缓存值是 **V8 structured clone**（不是 JSON）：字符串 = 标签 + LEB128 长度 + 数据，
  `0x22` 是 Latin-1、`0x63` 是 UTF-16LE。**实测确认 `0x63` 的长度字段是字节数而不是字符数**
  —— 按字符数会正好读多一倍，模型名后面会吃掉下一个字段的字节。
- 客户端给「工作任务」专属模型的名称自带前缀（`工作任务 Pro`、`工作任务 Auto`），
  所以模式归属直接从缓存里就能读出来。**但带前缀不再等于隐藏**：0.4.1 起它们会被
  标记成 `taskMode` 并正常开放，只有 `DOUBAO_UNAVAILABLE_MODELS` 里的条目（目前仅
  「即将下线」的 `4`）被排除。缓存里缺了某条任务模型时，会从内置清单补齐。
- 缓存读不到、或解析结果不可信时，**回落到内置清单**，绝不清空用户的选择器。
- 结果缓存 10 分钟；卡片上的「刷新」（POST）会丢弃记忆重新读盘。
- `doctor` 第 5 项会报告这次到底是从缓存发现的、还是回落的。

当前这台机器上的实测输出：

```
[ ok ] models  客户端缓存 5 个模型，开放 6 个（仅排除「即将下线」等不可用条目）
```

## 实验性：工具调用（默认关闭）

**豆包没有函数调用通道。** 带 OpenAI 风格的 `tools` 发请求，服务端会**静默忽略**
——2026-10-22 实测：HTTP 200、流正常，但它转而使用自己的服务端搜索技能（流里冒出
`block_type 10101` 的「正在搜索」块），从头到尾没引用过我们声明的函数。这和
`model_item_key` 不校验是同一类事：字段根本没被读。

所以工具调用只能**在提示词里模拟**：把工具清单写进提示词，让模型输出一个
```` ```doubao-tool ```` 围栏包一个 JSON，再解析回标准 `tool_calls`。

| 项 | 值 |
| --- | --- |
| 开关 | 设置卡片「实验性：工具调用」，默认**关闭** |
| 配置字段 | `toolEmulation: boolean` |
| 围栏格式 | ```` ```doubao-tool ``\n`{"name":"…","arguments":{…}}` |
| 解析结果 | `delta.tool_calls` + `finish_reason: "tool_calls"`（流式与非流式一致） |
| 工具结果回传 | 入站 `role: "tool"` 折叠成 `[tool result] <name>: <content>` |

**实测数据**（2026-11-02）：

- 沙箱两工具循环：9 次调用、**0 次 JSON 格式错误**、5/5 轮收敛、平均 **11.5 秒/轮**、1 次重复调用
- 真机走 shim：第 1 轮 `finish_reason=tool_calls`、参数完整；回填结果后给出结论、无误围栏泄漏
- **反例**：让它「查天气」时它**不调用我们的工具**，而是用自带的联网搜索直接答
  —— 所以这套只在豆包自身不具备的能力上可靠（读写文件、跑命令），在它已有技能
  （搜索、生图、翻译）上会绕过。

**失败模式是重复调用**（没有原生 stop token），因此解析层内置去重，调用方仍需设置步数上限。
这是一套**模拟**，上游模型换了输出习惯就可能退化 —— 这是它默认关闭、并且每条注释都写明
「measured / simulated」的原因。

验证脚本：`node scripts/verify-tool-emulation.mjs`（只验证协议链路，不执行工具）。

---

## 工作原理

```
DSH (pi-ai provider)
  └─ doubao-adapter ──► 本机 loopback shim (127.0.0.1，仅本进程密钥)
                         └─ doubao-upstream ──► 豆包 /chat/completion
                                                （带上密封会话里的 cookie）
```

1. **凭据**：只来自浏览器扫码 —— 一次 CDP `Storage.getCookies`，立刻用 Windows DPAPI
   密封到 `~/.dsh/doubao-credentials-browser.dpapi`；读出的值只进请求头，**从不**写日志、
   命令行、环境变量或其它文件。
2. **provider**：把 pi-ai 的 OpenAI 形状请求翻译成豆包方言（`bot_id` + `reasoning_effort`）。
3. **流式**：上游的三行帧被解析成 pi-ai 的事件流，工具调用 / 压缩 / 权限仍由 Harness 掌控。
4. **只读路由**：`/plugins/dsh-connect-doubao/quota` 与 `/catalog` 提供额度与目录，
   按**显式允许清单**构造响应，不透传上游任何字段，并拒绝非 loopback 来源。

---

## 安装

### 三种方式

```bash
# ① 通过 DSH CLI（推荐）
dsh plugin --profile desktop add dsh-connect-doubao

# ② npm 直装
npm install -g dsh-connect-doubao
dsh plugin --profile desktop add dsh-connect-doubao

# ③ 本地开发（不发布，直接挂源码目录）
dsh plugin --profile desktop add "E:\path\to\dsh-connect-doubao"
```

> 方式 ③ 会写成 `link:` 依赖，改完源码 `npm run build` 即可，**不需要重装**。

### 受支持的宿主范围

| 项目 | 版本 |
| --- | --- |
| DeepSeek Harness | `>=0.1.7-rc.1 <0.3.0-0`（实测：`0.2.0-rc.2`） |
| `@earendil-works/pi-ai` | `>=0.85.0 <0.88.0`（宿主实测：`0.87.1`） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

官方 `@deepseek-ai/*` 依赖全部声明为 **`peerDependencies`**（不打包，由宿主提供），
这既是插件市场的硬性要求，也保证运行期用的是宿主那一份。

---

## 平台支持

| 平台 | 状态 |
| --- | --- |
| **Windows x64** | ✅ 实测验证（DPAPI 密封） |
| macOS | ⚠️ 新支持（AES-256-GCM 密封，实测登录可用） |
| Linux | ⚠️ 新支持（同 macOS，未实测） |

**登录态**只有一个来源（`src/doubao-auth.ts` + `src/doubao-auth-browser.ts`）：

1. 卡片点「重新登录」→ 拉一个独立的 Chromium 用户目录（`~/.dsh/doubao-browser-profile`），
   打开 `https://www.doubao.com/chat/`；
2. 扫码（或手机号验证）完成 → 通过 CDP `Storage.getCookies` 一次取回全部 cookie；
3. 只保留豆包/Bytedance 域下、且 9 个必需会话 cookie 齐备的那份，密封到
   `~/.dsh/doubao-credentials-browser.dpapi`：Windows 用 DPAPI（当前用户作用域），macOS / Linux
   用 AES-256-GCM（密钥在 `~/.dsh/doubao-credential-key`，0600）。别的账户和别的机器解不开；
4. 之后所有请求只读这个密封文件，进程内缓存 10 分钟。

**为什么不再解密豆包客户端的 cookie。** 客户端运行时对 `Default\Network\Cookies` 持**独占锁**，
而本插件恰恰是为「客户端正在运行」的账号准备的：读不到 → 回退到 12 小时前的密封副本 →
服务端早已换过会话 → 每个请求都被上游拒绝，而本地状态还显示「已登录」，用户无从判断。
浏览器扫码没有这个死结：cookie 是当场抓到的，密封的也是刚抓到的，不存在更旧的副本可用。

**数据目录（与登录无关）。** `listDoubaoProfiles`（`src/doubao-profile.ts`）按代价从低到高：
配置文件里的 `profileDir` / 环境变量 `DSH_DOUBAO_PROFILE` → AppData 候选 → 运行中客户端的
`--user-data-dir` → 限时扫盘。它现在只用于模型清单的客户端缓存与「工作任务」模式的本地工作区；
命中不到时工作区退回临时目录，仍然可以对话。

---

## 命令行

```bash
# 体检整条链路（不消耗推理额度）
dsh-connect-doubao-doctor
dsh-connect-doubao-doctor --json

# 冒烟探针（会消耗一次推理额度）
dsh-connect-doubao-probe --prompt "hi"
dsh-connect-doubao-probe --prompt "hi" --model 5 --thinking high --json
```

`probe` 的完整参数：

```
--prompt <text>              提示词（默认 "hi"）
--model <key>                模型 id，见上表
--thinking <low|mid|high>    推理强度
--json                       输出 JSON
--timeout <ms>               超时（默认 120000）
```

`doctor` 输出五项独立结论：凭据 / 账号 / provider 装配 / 额度 / 模型发现。
凭据只报**数量**，不报值。

---

## 开发

```bash
npm install
npm run typecheck   # 节点侧 + 浏览器侧两套 tsconfig
npm run build       # 两个 target：node(ESM) + browser(CJS)
npm run test        # 客户端产物格式回归
npm run check       # 以上全部
```

> ⚠️ 浏览器侧产物**必须是 CommonJS**：桌面外壳用 `<script>` 加载它，不加 `type="module"`。
> ESM 会直接抛 `Cannot use import statement outside a module`，
> 并让整个 web boot 失败（`1 entry did not activate`）。
> `tests/client-bundle-format.test.ts` 钉住了这条规则。

---

## 已知限制（请如实预期）

1. **使用非官方接口。** 豆包没有公开的第三方 API，本插件逆向其客户端行为。
   上游任何改动都可能让它失效，且**不会有预告**。
2. **`'4'`（豆包 2.1 Turbo「即将下线」）未实测。** 其余 5 个条目已实测可对话。
3. **无法从响应侧独立验证"确实是这个模型"。** 上游 SSE 的 `message.ext` 里有一个
   不透明标记（实测为 `38`），它**不是**版本号也不是档位，字节跳动从未公布其含义 ——
   所以**没有**一个响应侧的字段可以拿来证明"服务端真的用了你选的那个模型"。
   本插件能确定的是：它把 `model_item_key` 随请求发出（这已抓包确认）。
   至于服务端如何解释这个键，只能由服务端回答。
4. **密封方式按平台**：Windows DPAPI / macOS·Linux AES-256-GCM（macOS 登录实测可用）。
   豆包客户端**不需要**安装：登录态只来自浏览器扫码。数据目录只在两处还会被读到 ——
   模型清单缓存与「工作任务」模式的本地工作区 —— 自动探测几层（配置文件里的 `profileDir`、
   环境变量 `DSH_DOUBAO_PROFILE`、AppData 候选、运行中客户端的 `--user-data-dir`、限时扫盘）；
   全落空时工作区退回临时目录，**不再影响登录**。
5. **风控滑块无法自动处理。** 触发后需在弹出的登录窗口里手动完成验证，再点一次「重新登录」。
6. **图片输入未提供。** 本 provider 只发送文本块，不转发图片。
7. **单账号。** 没有账号池、没有区域切换、没有签到。
8. **「工作任务」能跑，但扣不扣费取决于这一轮做了什么。** `agent_mode` 的取值是
   `2 = 普通对话`、`1 = 工作任务`（CDP 抓包实测，2026-10-22）。任务模式下服务端把每一轮交给
   `Agent-GeneralTask`，并由插件并发跑一个 `tool_local` 应答器（`msg/ack` →
   `upload_command_result` → `msg/complete`）把本地指令走完，所以不再必然回 `710010702`。
   **但纯文本、不触发本地工具的小回合，服务端会在 `ext` 里标
   `general_agent_task_mode: "simple"` 与 `mode_downgrade_reason: "success"`，此时活动赠送
   额度的 `usedAmount` 不变**（实测调用前后恒为 782，即「走降级、不计费」）。想让任务模型
   真正消耗付费额度，得让它执行多步工具/文档任务。这一条是实测结论，不是产品承诺。
9. **`model_item_key` 服务端不校验，所以「选中哪个模型」只能靠模式与账号决定。** 三条证据
   （2026-10-23）：
   1. CDP 抓到 App 选 2.1 Pro 时的真实请求：`model_item_key: "5"` + `mode_id: "3"` +
      `agent_mode: 1` + `general_task_param.runtime_type: 2`（本地电脑）。
   2. 用 `mode_id=3` + `key=5` 在对话模式发请求：正常回答，但与 `key=0` 无可测差异
      （耗时 15.1–17.6 s、长度 311–340 字，均在噪声范围内）。
   3. **真正的对照**：把三处 `model_item_key` 全部改成一个不存在的值直接发送，服务端仍返回
      200 与完整正常流，没有任何错误帧 —— 它不校验这个字段。
   所以 0.4.1 能提供的是**「工作任务模式 + 该 key」这一整组请求形态**（实测能出答案），
   而不是「服务端一定会用 Pro 而不是 Lite 来算」。要更强的模型，仍建议在豆包客户端里确认。
10. **本插件的设置不走宿主 settings，存在自己的 JSON 文件里。**
    `~/.dsh/dsh-connect-doubao.settings.json`，由插件自己写入（先写临时文件再原子重命名），
    读取也不依赖任何宿主服务在线。原因是宿主这条路对本插件**完全关闭**：它的 fiber 永远停在
    `state 1`（LOADING，和 `hmr`、`credentials` 一样），因此 `entry.fiber.runtime.Config`
    从不挂载 → 宿主 `describe()` 直接过滤掉这个命名空间 → 任何写入都以
    `No configurable plugin entry "dsh-connect-doubao"` 失败。
    **历史上这个插件的设置一次都没能落盘过**（包括手工改的），所以卡片会出现「点了没反应 /
    `host did not persist the value` / 保存成功但刷新后回退」三种症状。
    schema 里仍然保留 `asVolatile()`：那是宿主侧的正当声明，一旦上游修好 fiber 生命周期，
    走宿主路径也不会再踩坑；只是在当前版本上它不再决定成败。`tests/store.test.ts` 和
    `tests/save-route.test.ts` 钉住文件语义与路由安全边界。

---

## 免责声明

本项目仅供**个人学习与研究**使用。

- 使用本插件即表示你同意遵守**豆包（Doubao）的服务条款**；
- 使用风险自负，**本项目作者不对任何账号封禁、额度损失或数据后果承担责任**；
- 本项目与**字节跳动（ByteDance）**、**DeepSeek**、**DeepSeek Harness** 官方**无任何关联或背书**；
- 请勿用于商业用途或任何超出个人学习范围的场景。

---

## 致谢

- **dsh-connect-workbuddy** —— 本插件在**设计思路与插件结构**上借鉴了它的做法
  （loopback shim、provider 注册链路、设置卡片挂载、构建与打包约定），
  **所有代码均为独立实现**，未复制其源码。

## 第三方开源依赖

| 依赖 | 用途 |
| --- | --- |
| `@earendil-works/pi-ai` | 模型 provider 运行时（宿主提供） |
| `@deepseek-ai/*` | Harness 插件框架（宿主提供） |
| `@deepseek-ai/schemastery` | 设置 schema（宿主提供） |

运行时**不引入**任何第三方连接器插件。

## 许可证

[MIT](./LICENSE)
