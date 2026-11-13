/**
 * Bilingual copy for the Doubao plugin card.
 *
 * Same key/value system the reference connector uses: one flat key map per
 * language, and a `t` bound at registration time. Keys are the contract —
 * `Translate` is typed against `zh`'s keys, so adding a key to `en` and not to
 * `zh` (or vice versa) is a type error rather than a runtime `undefined`.
 *
 * @module dsh-connect-doubao/client-locales
 */

/** Chinese copy. The key set that defines the contract. */
export const zh = {
  'card.title': '豆包连接',
  'card.subtitle': '浏览器扫码登录一次，之后纯 HTTP 调用，不依赖豆包客户端。',

  'card.navLabel': '豆包',
  'quota.plan': '套餐',
  'quota.fiveHour': '5 小时限额',
  'quota.weekly': '周额度',
  'quota.used': '已用 {percent}%',
  'quota.resetsIn': '{time} 后重置',
  'quota.refresh': '刷新额度',
  'quota.refreshing': '刷新中…',
  'quota.autoNote': '每 5 分钟自动刷新',
  'quota.updatedAt': '更新于 {time}',
  'quota.windowMissing': '本套餐不含此额度',
  'quota.resetUnknown': '重置时间未知',
  'quota.startsOnUse': '开始使用后计时',
  'quota.expiresIn': '{time} 后到期',
  'quota.incentive': '赠送额度',
  'quota.usedAmounts': '已用 {used} / {total}',
  'quota.remainingAmount': '剩 {remaining} / {total}',
  'quota.remainingPercent': '剩 {percent}%',

  'account.title': '账号状态',
  'account.ok': '已登录',
  'account.signed_out': '未登录：请点下面的「重新登录」扫码一次',
  'account.unreadable': '登录信息读不出来：本机保存的会话无法解密，请重新登录一次',
  'account.session_dead': '登录态已失效：请点「重新登录」重新扫码',
  'account.risk_challenge': '触发了风控验证：请在弹出的登录窗口里手动完成滑块验证',
  'account.exhausted': '额度已用尽：等待窗口重置，或在豆包客户端查看「订阅与额度管理」',
  'account.network': '连接豆包失败：请检查网络后重试',
  'account.unknown': '状态未知',
  'account.profile': '配置目录',

  'models.title': '模型',
  'models.enabledCount': '已启用 {count} ↑',
  'models.routingNote': '清单、倍率、思考档位都直接读自豆包客户端菜单，豆包上新或调价会自动出现，不需要等插件更新。带「工作任务」徽章的条目走任务模式与会员付费额度，插件会自动完成本地指令应答。缓存的档位是蓝图，实线=已在真实请求中验证，虚线=仅菜单声明',
  'models.refresh': '刷新',
  'models.refreshing': '刷新中…',
  'models.save': '保存',
  'models.saving': '保存中…',
  'models.discard': '放弃更改',
  'models.selectAll': '全选',
  'models.selectNone': '全不选',
  'models.dirty': '有未保存的更改',
  'models.saved': '已保存',
  'models.saveFailed': '保存失败：{reason}',
  'models.tier': '档位',
  'models.tierFast': '快速',
  'models.tierThink': '思考',
  'models.tierExpert': '专家',
  'models.readOnly': '当前宿主未提供设置写入通道，勾选不会生效',
  'models.loadFailed': '模型目录读取失败',
  'models.empty': '没有可用的模型条目',
  'models.levelVerified': '已在真实请求中验证',
  'models.levelUnverified': '客户端菜单声明，尚未在真实请求中验证',
  'models.rateNote': '倍率来自豆包客户端菜单，仅作展示；本插件不参与计费，也无法核对实际扣费',

  'tools.title': '实验性：工具调用',
  'tools.toggle': '让豆包驱动本地工具（读写文件、执行命令）',
  'tools.note': '豆包的接口没有函数调用通道（声明的 tools 会被静默忽略），此开关改用提示词模拟：把工具清单写进提示词，再把回复里的围栏解析回标准 tool_calls。实测约 11.5 秒/轮，复杂任务可能退化，故默认关闭。',
  'tools.warning': '开启后豆包可以读写这台机器上的文件。请确认你信任当前会话的权限范围。',
  'tools.enabled': '已开启',
  'tools.disabled': '已关闭',

  'auth.title': '登录方式',
  'auth.signedIn': '已登录',
  'auth.signedOut': '未登录',
  'auth.expires': '{days} 天后到期',
  'auth.expiryUnknown': '到期时间未知',
  'auth.relogin': '重新登录',
  'auth.relogining': '等待扫码…',
  'auth.loginFailed': '登录失败：{reason}',

  'picker.controlLabel': '倍率 {rate}',
  'picker.controlUnknown': '倍率 --',
  'picker.controlAria': '查看豆包模型倍率（当前 {rate}）',
  'picker.popoverTitle': '豆包模型倍率',
  'picker.refresh': '刷新',
  'picker.refreshing': '刷新中…',
  'picker.currentBadge': '当前',
  'picker.rateTooltip': '豆包客户端菜单标示的计费倍率（仅供参考）',
  'picker.empty': '暂无模型倍率信息',
  'picker.rateUnavailable': '--',

  'stats.title': '会话统计与 Token 用量',
  'stats.sessionsActive': '活跃会话 {count}',
  'stats.empty': '本次会话启动后暂无已完成的对话轮次',
  'stats.loadFailed': '未能读取会话统计信息',
  'stats.requestsLabel': '请求与会话',
  'stats.requestsValue': '{succeeded} 次成功 · {continuations} 次续接 · {failed} 次失败',
  'stats.totalTokensLabel': '累计 Token',
  'stats.totalTokensValue': '{total}（输入 {input} / 输出 {output}）',
  'stats.tokenBreakdown': '未缓存输入 {uncached} · 上下文缓存 {cached} · 思考 {reasoning}',
  'stats.latencyLabel': '响应与生成速度',
  'stats.latencyValue': '首字 TTFT {ttft} · 速率 {tps} tok/s',
  'stats.cacheHitRate': '缓存命中率 {rate}',
  'stats.upstreamWindowLabel': '最近一轮上游窗口',
  'stats.upstreamWindowValue': '{used} / {window}（系统 {system} · 消息 {messages} · 工具 {tools}）',
  'stats.refresh': '刷新统计',
  'stats.refreshing': '刷新中…',
  'stats.reset': '清零统计',
  'stats.note': '实时累计本进程通过 Doubao 转发的所有请求与 DSH 原生 token 用量；上游服务端窗口仅工作任务轮次上报',
} as const

/** Every key the card can ask for. */
export type DoubaoCardKey = keyof typeof zh

/** English copy, typed to the Chinese key set. */
export const en: Record<DoubaoCardKey, string> = {
  'card.navLabel': 'Doubao',
  'card.title': 'Doubao connection',
  'card.subtitle': 'One QR sign-in in a browser window, then plain HTTP; no Doubao app required.',

  'quota.plan': 'Plan',
  'quota.fiveHour': '5-hour limit',
  'quota.weekly': 'Weekly quota',
  'quota.used': '{percent}% used',
  'quota.resetsIn': 'resets in {time}',
  'quota.refresh': 'Refresh quota',
  'quota.refreshing': 'Refreshing…',
  'quota.autoNote': 'Refreshes automatically every 5 minutes',
  'quota.updatedAt': 'updated {time}',
  'quota.windowMissing': 'not part of this plan',
  'quota.resetUnknown': 'reset time unknown',
  'quota.startsOnUse': 'starts counting on first use',
  'quota.expiresIn': 'expires in {time}',
  'quota.incentive': 'Bonus quota',
  'quota.usedAmounts': '{used} / {total} used',
  'quota.remainingAmount': '{remaining} of {total} left',
  'quota.remainingPercent': '{percent}% left',

  'account.title': 'Account status',
  'account.ok': 'Signed in',
  'account.signed_out': 'Not signed in: press “Sign in again” and scan the QR code',
  'account.unreadable': 'Sign-in could not be read: the sealed session failed to decrypt. Sign in again',
  'account.session_dead': 'Session expired: sign in again and scan the QR code',
  'account.risk_challenge': 'Risk-control challenge hit: complete the slider in the sign-in window that just opened',
  'account.exhausted': 'Quota exhausted: wait for the window to reset, or check subscription management in the Doubao app',
  'account.network': 'Could not reach Doubao: check the network and retry',
  'account.unknown': 'Status unknown',
  'account.profile': 'Profile path',

  'models.title': 'Models',
  'models.enabledCount': '{count} enabled ↑',
  'models.routingNote': 'The list, the multipliers and the thinking levels all come from the Doubao client menu, so new models or prices appear without a plugin update. Entries badged 「工作任务」 run in task mode against the paid membership quota; the plugin answers the local workspace commands for you. Solid chip = verified on a real request, dotted = declared by the menu only',
  'models.refresh': 'Refresh',
  'models.refreshing': 'Refreshing…',
  'models.save': 'Save',
  'models.saving': 'Saving…',
  'models.discard': 'Discard changes',
  'models.selectAll': 'Select all',
  'models.selectNone': 'Select none',
  'models.dirty': 'unsaved changes',
  'models.saved': 'Saved',
  'models.saveFailed': 'Save failed: {reason}',
  'models.tier': 'Tier',
  'models.tierFast': 'Fast',
  'models.tierThink': 'Thinking',
  'models.tierExpert': 'Expert',
  'models.readOnly': 'This host provides no settings write path; ticking has no effect',
  'models.loadFailed': 'Could not read the model catalog',
  'models.empty': 'No model entries available',
  'models.levelVerified': 'Verified on a real request',
  'models.levelUnverified': 'Declared by the client menu, not yet verified on a request',
  'models.rateNote': 'Multipliers come from the Doubao client menu and are display-only; this plugin does not bill and cannot verify the actual charge',

  'tools.title': 'Experimental: tool calling',
  'tools.toggle': 'Let Doubao drive local tools (read/write files, run commands)',
  'tools.note': 'Doubao\'s endpoint has no function-calling channel — a declared `tools` array is silently ignored — so this switch simulates it: the tool list goes into the prompt and the fenced block in the reply is parsed back into standard tool_calls. Measured ~11.5s per round; can degrade on complex tasks, hence off by default.',
  'tools.warning': 'When on, Doubao can read and write files on this machine. Make sure you trust the permission scope of the current session.',
  'tools.enabled': 'On',
  'tools.disabled': 'Off',

  'auth.title': 'Sign-in',
  'auth.signedIn': 'Signed in',
  'auth.signedOut': 'Not signed in',
  'auth.expires': 'expires in {days} days',
  'auth.expiryUnknown': 'expiry unknown',
  'auth.relogin': 'Sign in again',
  'auth.relogining': 'Waiting for the scan…',
  'auth.loginFailed': 'Sign-in failed: {reason}',

  'picker.controlLabel': 'Rate {rate}',
  'picker.controlUnknown': 'Rate --',
  'picker.controlAria': 'View Doubao model multipliers (current {rate})',
  'picker.popoverTitle': 'Doubao model multipliers',
  'picker.refresh': 'Refresh',
  'picker.refreshing': 'Refreshing…',
  'picker.currentBadge': 'Current',
  'picker.rateTooltip': 'Billing multiplier shown in the Doubao client menu (display-only)',
  'picker.empty': 'No model multiplier data',
  'picker.rateUnavailable': '--',

  'stats.title': 'Session stats & token usage',
  'stats.sessionsActive': '{count} active sessions',
  'stats.empty': 'No completed turns recorded since this session started',
  'stats.loadFailed': 'Could not read session statistics',
  'stats.requestsLabel': 'Requests & turns',
  'stats.requestsValue': '{succeeded} succeeded · {continuations} continuations · {failed} failed',
  'stats.totalTokensLabel': 'Total tokens',
  'stats.totalTokensValue': '{total} ({input} in / {output} out)',
  'stats.tokenBreakdown': 'Uncached in {uncached} · Cached in {cached} · Reasoning {reasoning}',
  'stats.latencyLabel': 'Latency & speed',
  'stats.latencyValue': 'TTFT {ttft} · {tps} tok/s',
  'stats.cacheHitRate': 'Cache hit {rate}',
  'stats.upstreamWindowLabel': 'Last upstream window',
  'stats.upstreamWindowValue': '{used} / {window} (sys {system} · msgs {messages} · tools {tools})',
  'stats.refresh': 'Refresh stats',
  'stats.refreshing': 'Refreshing…',
  'stats.reset': 'Reset stats',
  'stats.note': 'Aggregates runtime Doubao traffic alongside DSH native token & session metrics; upstream window is reported by task turns',
}

/** Locale namespace registered by the browser-plugin entry. */
export const NAMESPACE = 'settings.doubao'

/**
 * `t` as the card receives it from `ctx.locale.bind(namespace)`.
 *
 * Placeholders are replaced here rather than at each call site so the card
 * never assembles sentences — which is what keeps the two languages' word order
 * free.
 */
export type Translate = (key: DoubaoCardKey, vars?: Record<string, string | number>) => string

/** Bind a language table into the `t` the card uses. */
export function translator(table: Record<DoubaoCardKey, string>): Translate {
  return (key, vars) => {
    const template = table[key] ?? key
    if (vars === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = vars[name]
      return value === undefined ? match : String(value)
    })
  }
}