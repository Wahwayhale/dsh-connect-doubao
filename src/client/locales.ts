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
  'card.subtitle': '复用本机豆包客户端的登录态，不额外登录。',

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
  'quota.windowMissing': '未返回该额度窗口',
  'quota.resetUnknown': '重置时间未知',
  'quota.startsOnUse': '开始使用后计时',
  'quota.expiresIn': '{time} 后到期',
  'quota.incentive': '赠送额度',
  'quota.usedAmounts': '已用 {used} / {total}',

  'account.title': '账号状态',
  'account.ok': '已登录',
  'account.signed_out': '未登录：请在豆包客户端登录后重试',
  'account.unreadable': '登录信息读不出来：本机凭据无法解密，请检查豆包客户端是否正常安装并已登录',
  'account.session_dead': '登录态已失效：请在豆包客户端重新登录',
  'account.risk_challenge': '触发了风控验证：请打开豆包客户端手动发一条消息完成滑块验证',
  'account.exhausted': '额度已用尽：等待窗口重置，或在豆包客户端查看「订阅与额度管理」',
  'account.network': '连接豆包失败：请检查网络后重试',
  'account.unknown': '状态未知',
  'account.profile': '配置目录',

  'models.title': '模型',
  'models.enabledCount': '已启用 {count} ↑',
  'models.routingNote': '清单直接读自豆包客户端的缓存，豆包上线新模型时会自动出现，不需要等插件更新。「工作任务」专属的条目（2.1 Pro / Lite / Auto）由客户端内的运行时执行，外部客户端接不进去，已自动隐藏',
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

  'profile.title': '豆包数据目录',
  'profile.detected': '自动探测到',
  'profile.none': '没找到：豆包可能还没安装，或数据放在了别的位置',
  'profile.manual': '已手动指定',
  'profile.pick': '选择目录…',
  'profile.picking': '等待选择…',
  'profile.clear': '改回自动探测',
  'profile.current': '当前使用',
  'profile.hintTitle': '该选哪个目录？',
  'profile.hint': '选豆包客户端存放数据的那个文件夹，里面应该有一个叫 Default 的子文件夹（Default\\Network\\Cookies 就是登录信息）。常见位置：%LOCALAPPDATA%\\Doubao\\User Data。如果你在装豆包时改过「数据目录」，或后来把整个 User Data 文件夹搬到了 D 盘，就选搬过去的那个。选上层文件夹（例如 D:\\Doubao）也可以，插件会自动往下找一层 User Data。',
  'profile.invalid': '这个目录里没有豆包数据（缺少 Default\\Network\\Cookies）',
  'profile.envNote': '也可以设环境变量 {env}，它的优先级最高。',
  'profile.pickFailed': '打开目录选择器失败：{reason}',

  'tools.title': '实验性：工具调用',
  'tools.toggle': '让豆包驱动本地工具（读写文件、执行命令）',
  'tools.note': '豆包的接口没有函数调用通道（声明的 tools 会被静默忽略），此开关改用提示词模拟：把工具清单写进提示词，再把回复里的围栏解析回标准 tool_calls。实测约 11.5 秒/轮，复杂任务可能退化，故默认关闭。',
  'tools.warning': '开启后豆包可以读写这台机器上的文件。请确认你信任当前会话的权限范围。',
  'tools.enabled': '已开启',
  'tools.disabled': '已关闭',
} as const

/** Every key the card can ask for. */
export type DoubaoCardKey = keyof typeof zh

/** English copy, typed to the Chinese key set. */
export const en: Record<DoubaoCardKey, string> = {
  'card.navLabel': 'Doubao',
  'card.title': 'Doubao connection',
  'card.subtitle': 'Reuses the sign-in already held by the local Doubao app; no separate login.',

  'quota.plan': 'Plan',
  'quota.fiveHour': '5-hour limit',
  'quota.weekly': 'Weekly quota',
  'quota.used': '{percent}% used',
  'quota.resetsIn': 'resets in {time}',
  'quota.refresh': 'Refresh quota',
  'quota.refreshing': 'Refreshing…',
  'quota.autoNote': 'Refreshes automatically every 5 minutes',
  'quota.updatedAt': 'updated {time}',
  'quota.windowMissing': 'window not reported',
  'quota.resetUnknown': 'reset time unknown',
  'quota.startsOnUse': 'starts counting on first use',
  'quota.expiresIn': 'expires in {time}',
  'quota.incentive': 'Bonus quota',
  'quota.usedAmounts': '{used} / {total} used',

  'account.title': 'Account status',
  'account.ok': 'Signed in',
  'account.signed_out': 'Not signed in: sign in to the Doubao app and retry',
  'account.unreadable': 'Sign-in could not be read: local credentials failed to decrypt. Check that the Doubao app is installed normally and signed in',
  'account.session_dead': 'Session expired: sign in again to the Doubao app',
  'account.risk_challenge': 'Risk-control challenge hit: open the Doubao app and send one message to clear the slider',
  'account.exhausted': 'Quota exhausted: wait for the window to reset, or check subscription management in the Doubao app',
  'account.network': 'Could not reach Doubao: check the network and retry',
  'account.unknown': 'Status unknown',
  'account.profile': 'Profile path',

  'models.title': 'Models',
  'models.enabledCount': '{count} enabled ↑',
  'models.routingNote': 'Only the 对话-mode entries are offered (快速 / 专家). The 「工作任务」-only models (2.1 Pro / 2.1 Lite) are executed by the Doubao desktop app runtime, which an external client cannot join',
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

  'profile.title': 'Doubao data directory',
  'profile.detected': 'Detected automatically',
  'profile.none': 'Not found — the app may not be installed, or its data lives elsewhere',
  'profile.manual': 'Set manually',
  'profile.pick': 'Choose folder…',
  'profile.picking': 'Waiting for the picker…',
  'profile.clear': 'Back to automatic',
  'profile.current': 'In use',
  'profile.hintTitle': 'Which folder should I pick?',
  'profile.hint': 'Pick the folder where the Doubao app keeps its data. It should contain a subfolder called Default — Default\\Network\\Cookies is the sign-in. The usual place is %LOCALAPPDATA%\\Doubao\\User Data. If you changed the "data directory" during install, or moved the whole User Data folder to D:, pick where you moved it. Picking the parent (e.g. D:\\Doubao) also works: the plugin looks one level down for User Data.',
  'profile.invalid': 'That folder holds no Doubao data (no Default\\Network\\Cookies)',
  'profile.envNote': 'You can also set the {env} environment variable; it takes precedence over everything.',
  'profile.pickFailed': 'Could not open the folder picker: {reason}',

  'tools.title': 'Experimental: tool calling',
  'tools.toggle': 'Let Doubao drive local tools (read/write files, run commands)',
  'tools.note': 'Doubao\'s endpoint has no function-calling channel — a declared `tools` array is silently ignored — so this switch simulates it: the tool list goes into the prompt and the fenced block in the reply is parsed back into standard tool_calls. Measured ~11.5s per round; can degrade on complex tasks, hence off by default.',
  'tools.warning': 'When on, Doubao can read and write files on this machine. Make sure you trust the permission scope of the current session.',
  'tools.enabled': 'On',
  'tools.disabled': 'Off',
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