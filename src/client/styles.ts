/**
 * Card styling, delivered as one scoped stylesheet string.
 *
 * A string (not a CSS import) because the browser bundle is injected into the
 * host page at runtime: a `import './x.css'` would need a bundler plugin the
 * client build deliberately does not use, and a `<style>` element inserted on
 * mount keeps the card self-contained.
 *
 * Every selector is namespaced under `dbq-` so nothing here can reach a host
 * element, and every rule uses explicit colours rather than host tokens — a
 * card that inherited the host's theme variables would render unreadable the
 * moment the host renames one.
 *
 * Colours are checked for contrast against their own background (all text
 * pairs are >= 4.5:1, the WCAG AA threshold for body text).
 *
 * @module dsh-connect-doubao/client-styles
 */
export const DOUBAO_CARD_CSS = `
.dbq-card { display: flex; flex-direction: column; gap: 14px; padding: 14px;
  border: 1px solid #2b2f36; border-radius: 10px; background: #16181d; color: #e8eaed;
  font-size: 13px; line-height: 1.5; }
.dbq-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dbq-title { font-weight: 600; font-size: 14px; }
.dbq-sub { color: #9aa0a6; font-size: 12px; }

.dbq-section { display: flex; flex-direction: column; gap: 8px; }
.dbq-section-title { font-weight: 600; font-size: 13px; display: flex;
  align-items: baseline; justify-content: space-between; gap: 8px; }
.dbq-count { color: #9aa0a6; font-size: 12px; font-weight: 400; }
.dbq-note { color: #9aa0a6; font-size: 12px; }

.dbq-row { display: flex; flex-direction: column; gap: 4px; }
.dbq-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dbq-label { font-weight: 500; }
.dbq-meta { color: #9aa0a6; font-size: 12px; white-space: nowrap; }

.dbq-bar { height: 8px; border-radius: 999px; background: #2b2f36; overflow: hidden; }
.dbq-fill { height: 100%; border-radius: 999px; background: #4a9eff; transition: width .25s ease; }
.dbq-fill.dbq-warn { background: #f5a623; }
.dbq-fill.dbq-full { background: #e5534b; }

.dbq-state { display: flex; align-items: flex-start; gap: 6px; }
.dbq-dot { width: 8px; height: 8px; border-radius: 999px; margin-top: 5px; flex: none; background: #4a9eff; }
.dbq-dot.dbq-warn { background: #f5a623; }
.dbq-dot.dbq-bad { background: #e5534b; }
.dbq-state-text { color: #e8eaed; }
.dbq-profile { color: #9aa0a6; font-size: 11px; word-break: break-all; }

.dbq-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dbq-btn { appearance: none; border: 1px solid #3a3f47; background: #22252b; color: #e8eaed;
  border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.dbq-btn:hover:not(:disabled) { background: #2b2f36; }
.dbq-btn:disabled { opacity: .5; cursor: not-allowed; }
.dbq-btn.dbq-primary { border-color: #4a9eff; color: #cfe4ff; }
.dbq-btn.dbq-dirty { border-color: #f5a623; color: #ffd79a; }
.dbq-dirty-flag { color: #f5a623; font-size: 12px; }

.dbq-models { display: flex; flex-direction: column; gap: 6px; }
.dbq-model { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;
  border: 1px solid #262a30; border-radius: 6px; }
.dbq-model input[type=checkbox] { margin-top: 3px; flex: none; }
.dbq-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dbq-model-name { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.dbq-badge { font-size: 11px; color: #9aa0a6; border: 1px solid #33383f;
  border-radius: 4px; padding: 0 4px; }
.dbq-model-desc { color: #9aa0a6; font-size: 11px; }
.dbq-saved { color: #7fd18a; font-size: 12px; }
.dbq-error { color: #ff9d99; font-size: 12px; }
`