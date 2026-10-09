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
  'models.routingNote': '勾选的条目会出现在 DSH 模型选择器中，请求时按 model_item_key 指定模型',
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
  'models.routingNote': 'Ticked entries appear in the DSH model picker and are sent as model_item_key',
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