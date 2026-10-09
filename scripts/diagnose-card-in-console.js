/**
 * ============================================================================
 *  DSH 插件卡片诊断脚本 —— 粘贴到 DevTools Console 直接运行
 * ============================================================================
 *
 *  用途：判定「卡片没有显示」的真正原因，区分三类：
 *
 *    (1) 卡片根本没渲染        —— DOM 里搜不到「额度」，且槽位容器没有我们的子节点
 *    (2) 渲染了但溢出/被藏      —— 搜得到「额度」，但 rect 在视口外或尺寸为 0
 *    (3) 渲染了且可见          —— rect 与其它插件的卡片并排正常
 *
 *  为什么需要它：宿主 console 里没有 `[dsh-connect-doubao]` 开头的报错，说明
 *  卡片没有抛异常（我们的 apply() 用双层 try/catch 兜底，异常会被吞成
 *  console.error）。于是「不报错 + 不显示」只剩两类可能，必须靠 DOM 区分。
 *
 *  顺带验证疑点 A（configForms）：若 `window.__DSH_BOOT__` 里我们的 inject 带了
 *  configForms 却没有绑定成功，卡片会退化成只读（勾选不可保存）。
 *
 *  用法：打开 DSH GUI → 插件配置页 → F12 → Console → 整段粘贴回车。
 *        不修改任何状态，纯读取。
 * ============================================================================
 */
(function diagnoseDoubaoCard() {
  'use strict'

  const PLUGIN_ID = 'dsh-connect-doubao'
  const out = []
  const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s) }
  const hr = (t) => say('\n' + '='.repeat(68) + '\n' + t + '\n' + '='.repeat(68))

  say('DSH 插件卡片诊断 · 目标: ' + PLUGIN_ID)

  // ---------------------------------------------------------------- 0. 环境
  hr('0. 环境')
  say('  URL            :', location.href)
  say('  viewport       :', window.innerWidth + ' x ' + window.innerHeight)
  say('  __ModuleLoader__:', typeof window.__ModuleLoader__)
  say('  __DSH_BOOT__   :', typeof globalThis.__DSH_BOOT__)

  // ------------------------------------------------------- 1. boot manifest
  hr('1. 宿主 client 清单（__DSH_BOOT__）')
  const boot = globalThis.__DSH_BOOT__
  const entries = Array.isArray(boot?.entries) ? boot.entries : []
  say('  清单条目总数    :', entries.length)

  const mine = entries.find(e => e && e.id === PLUGIN_ID)
  if (mine === undefined) {
    say('  ❌ ' + PLUGIN_ID + ' 不在宿主 client 清单里 —— 宿主根本没打算加载它。')
    say('     ⇒ 属于「打包/登记」问题，不是渲染问题。')
  } else {
    say('  ✅ 找到条目:')
    say('     id     :', mine.id)
    say('     url    :', mine.url)
    say('     rev    :', mine.rev)
    say('     inject :', JSON.stringify(mine.inject))
    say('     清单位置 index:', entries.indexOf(mine), '/', entries.length)
    for (const dep of mine.inject ?? []) {
      const present = entries.some(e => e && e.id === dep)
      say('     依赖', present ? '✅ 已在清单' : '❌ 不在清单', dep)
    }
  }

  // 同类插件对照：谁在清单里、位置如何
  const peers = entries
    .filter(e => e && /^dsh-(connect|gemini|workbuddy|trae)/.test(e.id))
    .map(e => e.id)
  say('\n  清单里的连接器类插件:')
  for (const p of peers) say('    -', p, p === PLUGIN_ID ? '  ← 本插件' : '')

  // ---------------------------------------------------------- 2. DOM 容器
  hr('2. 槽位容器与子节点')

  // 槽位容器不一定带 data 属性，所以两种方式都试。
  function findSlotContainers(slotName) {
    const found = []
    for (const attr of ['data-slot', 'data-slot-name', 'data-plugin-slot', 'data-plugins-slot']) {
      document.querySelectorAll('[' + attr + ']').forEach(el => {
        if ((el.getAttribute(attr) ?? '') === slotName) found.push({ el, how: attr })
      })
    }
    // 兜底：class 名里含槽位名
    document.querySelectorAll('[class*="' + slotName.replace(/\./g, '-') + '"]').forEach(el => found.push({ el, how: 'class~' }))
    // 兜底：任意属性值恰好等于槽位名
    document.querySelectorAll('*').forEach(el => {
      for (const a of el.attributes ?? []) {
        if (a.value === slotName) { found.push({ el, how: a.name }); return }
      }
    })
    // 去重
    const seen = new Set()
    return found.filter(x => (seen.has(x.el) ? false : (seen.add(x.el), true)))
  }

  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
      visible: r.width > 0 && r.height > 0 &&
        r.right > 0 && r.bottom > 0 &&
        r.left < window.innerWidth && r.top < window.innerHeight,
    }
  }

  const dumpContainer = (slotName) => {
    say('\n  ── 槽位:', slotName, '──')
    const containers = findSlotContainers(slotName)
    if (containers.length === 0) {
      say('     ⚠️ 没找到带该槽位名的容器（宿主可能不用属性标记槽位，见第 4 节兜底搜索）')
      return
    }
    containers.forEach((c, ci) => {
      const cs = getComputedStyle(c.el)
      const r = rectOf(c.el)
      say(`     容器[${ci}] <${c.el.tagName.toLowerCase()}> (via ${c.how})`)
      say(`       子节点数   : ${c.el.children.length}`)
      say(`       rect      : w=${r.w} h=${r.h} x=${r.x} y=${r.y} visible=${r.visible}`)
      say(`       display   : ${cs.display}   flex-wrap: ${cs.flexWrap}   overflow: ${cs.overflow}`)
      say(`       flex-direction: ${cs.flexDirection}  gap: ${cs.gap}`)

      const kids = Array.from(c.el.children)
      kids.forEach((kid, ki) => {
        const kr = rectOf(kid)
        const cs2 = getComputedStyle(kid)
        const idAttr = kid.getAttribute('data-plugin') || kid.id || '(no id attr)'
        const text = (kid.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
        say(`         [${ki}] <${kid.tagName.toLowerCase()}> id=${idAttr}`)
        say(`             rect: w=${kr.w} h=${kr.h} x=${kr.x} y=${kr.y} visible=${kr.visible}`)
        say(`             display=${cs2.display} flexWrap=${cs2.flexWrap} minWidth=${cs2.minWidth} overflow=${cs2.overflow}`)
        say(`             text: ${text}`)
        // 溢出判据：宽度为 0，或完全在视口外
        const overflowed = kr.w === 0 || kr.h === 0 || (!kr.visible)
        if (overflowed) say(`             ⚠️ 该子节点不可见（宽高为 0 或在视口外）`)
      })
    })
  }

  dumpContainer('plugins.bundle.config')
  dumpContainer('plugins.row.config')

  // --------------------------------------------------- 3. 文本搜索（判读关键）
  hr('3. 文本搜索（本插件的中文文案）')
  const needles = ['额度', '标准套餐', '豆包', '5 小时限额', '周额度', '已用', '上游自动路由']
  const bodyText = (document.body?.innerText ?? '')
  for (const n of needles) {
    const count = bodyText.split(n).length - 1
    say(`  「${n}」 在页面可见文本中出现 ${count} 次`)
  }

  // 连卡片容器一起搜（innerText 会漏掉被 CSS 隐藏的元素）
  say('\n  在整个 document.body.innerHTML 中搜索:')
  const html = document.body?.innerHTML ?? ''
  for (const n of needles) {
    const count = html.split(n).length - 1
    say(`     「${n}」 ${count} 次`)
  }

  // ------------------------------------------------ 4. 按 class 前缀兜底搜索
  hr('4. 按卡片 class 前缀兜底搜索（.dbq-*）')
  const dbq = Array.from(document.querySelectorAll('[class*="dbq-"]'))
  say('  命中 .dbq-* 元素数:', dbq.length)
  // Declared OUTSIDE the branch below: the verdict block reads them even when
  // no card was found, and an in-branch `const` would be a ReferenceError there
  // (which is exactly what this script's own test caught).
  let badAncestors = []
  let _clippedByAncestor = false
  if (dbq.length > 0) {
    const card = dbq.find(el => el.classList.contains('dbq-card')) ?? dbq[0]
    const r = rectOf(card)
    say('  卡片根元素 :', '<' + card.tagName.toLowerCase() + '>', card.className)
    say('  rect       : w=%s h=%s x=%s y=%s visible=%s', r.w, r.h, r.x, r.y, r.visible)
    say('  计算样式   : display=' + getComputedStyle(card).display +
        ' visibility=' + getComputedStyle(card).visibility +
        ' opacity=' + getComputedStyle(card).opacity)
    say('  文本       :', (card.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120))
    // 逐层找出第一个尺寸为 0 或不可见的祖先
    let node = card
    badAncestors = []
    while (node && node !== document.body) {
      const rr = rectOf(node)
      const cs = getComputedStyle(node)
      if (rr.w === 0 || rr.h === 0 || cs.display === 'none' || cs.visibility === 'hidden') {
        badAncestors.push({ tag: node.tagName.toLowerCase(), cls: (node.className || '').toString().slice(0, 60), w: rr.w, h: rr.h, display: cs.display, visibility: cs.visibility })
      }
      node = node.parentElement
    }
    if (badAncestors.length === 0) {
      say('  ✅ 从卡片往上没有任何零尺寸 / display:none / visibility:hidden 的祖先')
    } else {
      say('  ⚠️ 以下祖先把卡片压没了（最可能是元凶）：')
      badAncestors.slice(0, 8).forEach(a => say('     <%s class="%s"> w=%s h=%s display=%s visibility=%s', a.tag, a.cls, a.w, a.h, a.display, a.visibility))
    }

    // An ancestor that CLIPS also hides the card even when the card's own rect
    // is healthy. `overflow: hidden|auto|scroll` plus an ancestor rect that does
    // not contain the card is the classic "rendered but invisible" cause, and the
    // card's own rect cannot see it — so test containment explicitly.
    const clipping = []
    let anc = card.parentElement
    while (anc && anc !== document.body) {
      const ar = rectOf(anc)
      const acs = getComputedStyle(anc)
      const clips = /hidden|auto|scroll|clip/.test(acs.overflow ?? '')
      if (clips && !(ar.x <= r.x && ar.y <= r.y && ar.x + ar.w >= r.x + r.w && ar.y + ar.h >= r.y + r.h)) {
        clipping.push({ tag: anc.tagName.toLowerCase(), cls: (anc.className || '').toString().slice(0, 60), overflow: acs.overflow, rect: ar })
      }
      anc = anc.parentElement
    }
    if (clipping.length === 0) {
      say('  ✅ 没有祖先的 overflow 把卡片裁掉')
    } else {
      say('  ⚠️ 以下祖先 overflow 裁剪区不含卡片（卡片被裁掉 = 看不见）：')
      clipping.slice(0, 6).forEach(a => say('     <%s class="%s"> overflow=%s rect={w:%s h:%s x:%s y:%s}', a.tag, a.cls, a.overflow, a.rect.w, a.rect.h, a.rect.x, a.rect.y))
    }
    _clippedByAncestor = clipping.length > 0
  }

  // ----------------------------------------------- 5. 样式表是否已注入
  hr('5. 卡片样式表')
  const styleEl = document.getElementById('dbq-card-styles')
  say('  #dbq-card-styles 存在:', styleEl !== null)
  if (styleEl !== null) {
    say('  规则条数约:', (styleEl.textContent.match(/\{/g) ?? []).length)
    say('  长度:', styleEl.textContent.length, 'chars')
  }

  // ---------------------------------------------------- 6. loader 注册状态
  hr('6. 模块加载器')
  const ml = window.__ModuleLoader__
  if (ml == null) {
    say('  ❌ window.__ModuleLoader__ 不存在')
  } else {
    say('  可用方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(ml) ?? {}).join(', ') || '(无原型方法)')
    // 不同宿主版本暴露的查询接口不同，逐个试
    for (const probe of ['manifest', 'modules', 'stats']) {
      try {
        const v = ml[probe]
        if (v === undefined) continue
        say(`  ${probe}:`, typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v))
      } catch { /* 忽略 */ }
    }
  }

  // -------------------------------------------------------- 判读结论
  hr('判读')
  const mineInBoot = mine !== undefined
  const dbqFound = dbq.length > 0
  const textFound = needles.some(n => html.includes(n))
  const cardVisible = dbq.length > 0 && rectOf(dbq.find(e => e.classList.contains('dbq-card')) ?? dbq[0]).visible

  const zeroSizedAncestor = dbqFound && badAncestors.length > 0
  const clipped = dbqFound && _clippedByAncestor === true

  say('  ① 在宿主 client 清单里      :', mineInBoot ? 'YES' : 'NO')
  say('  ② DOM 里有 .dbq-* 卡片元素  :', dbqFound ? 'YES' : 'NO')
  say('  ③ DOM 里能搜到中文文案      :', textFound ? 'YES' : 'NO')
  say('  ④ 卡片 rect 可见            :', cardVisible ? 'YES' : 'NO')
  say('  ⑤ 有零尺寸/隐藏的祖先        :', zeroSizedAncestor ? 'YES' : 'NO')
  say('  ⑥ 有祖先 overflow 裁掉卡片   :', clipped ? 'YES' : 'NO')

  let verdict
  if (!mineInBoot) {
    verdict = '【打包/登记】宿主清单里没有本插件 —— 与渲染无关。查 package.json 的 dsh 字段与 exports["./client"]。'
  } else if (!dbqFound && !textFound) {
    verdict = '【未渲染】清单里有，但 DOM 里完全没有卡片 —— 查 apply() 是否执行，以及 configForms 命名空间是否匹配。'
  } else if (clipped) {
    verdict = '【溢出/被裁】卡片确实渲染了，但被某个祖先的 overflow 裁掉了 —— 见第 4 节「overflow 裁剪」列表，那是元凶。'
  } else if (zeroSizedAncestor) {
    verdict = '【溢出/被压】卡片渲染了，但上方有零尺寸或 display:none 的祖先把它压没了 —— 见第 4 节「压没了的祖先」列表。'
  } else if (dbqFound && !cardVisible) {
    verdict = '【溢出/出视口】卡片 rect 不在视口内 —— 可能需要滚动，或被 transform 移出。'
  } else {
    verdict = '【已渲染且可见】卡片在页面里且 rect 正常。若你仍看不到，请截图当前 Plugins 配置页 —— 可能它在折叠区/需要滚动，或你看的是另一个 profile。'
  }
  say('\n  结论:', verdict)

  // 附：疑点 A（configForms 写入通道）快速自检
  hr('附：疑点 A 自检（模型勾选的保存通道）')
  say('  要判断勾选能否保存，需要确认宿主是否给本插件提供了 configForms 命名空间。')
  say('  宿主侧证据（若有）：')
  try {
    const g = globalThis.__DSH_CORDIS__ ?? globalThis.__dshCtx
    say('    全局 ctx 是否暴露:', g === undefined ? 'NO（宿主未暴露，无法从 console 直接读）' : 'YES')
  } catch { /* 忽略 */ }
  say('  若卡片上「保存」按钮是灰的、或模型列表不可勾选，')
  say('  说明 settingsScope 没绑上（configForms 软探测失败），此时勾选不会写回。')

  say('\n诊断结束。把上面全部输出贴回来即可。')
  return out.join('\n')
})()