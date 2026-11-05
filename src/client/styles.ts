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
 * Visual hierarchy: one soft surface for the card, one raised panel per quota
 * window, a hairline between sections, and exactly one loud element per row
 * (the "what is left" figure). Numbers use tabular figures so a countdown
 * ticking every second does not make the line jitter.
 *
 * @module dsh-connect-doubao/client-styles
 */
export const DOUBAO_CARD_CSS = `
.dbq-card { display: flex; flex-direction: column; gap: 16px; padding: 16px 18px;
  border: 1px solid #262b33; border-radius: 14px; color: #e8eaed;
  background:
    radial-gradient(120% 150% at 0% 0%, rgba(74, 158, 255, .12), transparent 58%),
    linear-gradient(180deg, #191c22 0%, #14161b 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04), 0 12px 30px -14px rgba(0, 0, 0, .8);
  font-size: 13px; line-height: 1.55; font-variant-numeric: tabular-nums; }

.dbq-head { display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; padding-bottom: 2px; }
.dbq-title { font-weight: 600; font-size: 15px; letter-spacing: .01em; }
.dbq-sub { color: #9aa0a6; font-size: 12px; }

.dbq-section { display: flex; flex-direction: column; gap: 10px; }
/* Hairline instead of a box per section: five bordered boxes read as a form,
   one card with dividers reads as a panel. */
.dbq-section + .dbq-section { padding-top: 16px; border-top: 1px solid #21252c; }
.dbq-section-title { font-weight: 600; font-size: 12px; letter-spacing: .05em;
  color: #b6bdc7; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
/* Counts and the plan name double as a pill, so they stop competing with the
   section label for the same visual weight. */
.dbq-count { color: #a8bdd4; font-size: 11px; font-weight: 500; letter-spacing: 0;
  background: #1e242c; border: 1px solid #2b323c; border-radius: 999px; padding: 1px 8px; }
.dbq-note { color: #9aa0a6; font-size: 12px; }

/* One raised panel per window: the row is the unit of the quota area, so it
   carries the surface instead of sitting bare on the card. */
.dbq-row { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  background: #13161b; border: 1px solid #20242b; border-radius: 10px;
  transition: border-color .15s ease, background .15s ease; }
.dbq-row:hover { border-color: #2c333d; background: #151920; }
.dbq-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.dbq-label { font-weight: 500; font-size: 12.5px; color: #dfe3e8; }
/* The loud element of the row: what is left, at a size the eye lands on first. */
.dbq-figure { font-size: 14px; font-weight: 600; color: #eef2f7; white-space: nowrap; }
.dbq-figure-sub { color: #9aa0a6; font-size: 12px; font-weight: 400; }
.dbq-row-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dbq-meta { color: #9aa0a6; font-size: 11.5px; white-space: nowrap; }
/* Candidate list: one path per line, and a long path must wrap instead of
   pushing the card wider than the settings panel. */
.dbq-candidates { color: #8b929b; font-size: 11.5px; white-space: pre-wrap; word-break: break-all;
  background: #12151a; border: 1px solid #1e222a; border-radius: 8px; padding: 8px 10px; }

.dbq-bar { height: 8px; border-radius: 999px; background: #1c2027; overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .03); }
.dbq-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #3b82f6, #60a5fa);
  box-shadow: 0 0 10px rgba(74, 158, 255, .4);
  transition: width .5s cubic-bezier(.22, .61, .36, 1), background .2s ease; }
.dbq-fill.dbq-warn { background: linear-gradient(90deg, #d97706, #fbbf24);
  box-shadow: 0 0 10px rgba(245, 166, 35, .38); }
.dbq-fill.dbq-full { background: linear-gradient(90deg, #dc2626, #ef4444);
  box-shadow: 0 0 10px rgba(229, 83, 75, .42); }

.dbq-state { display: flex; align-items: center; gap: 8px; }
.dbq-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; background: #4a9eff;
  box-shadow: 0 0 0 3px rgba(74, 158, 255, .18); }
.dbq-dot.dbq-warn { background: #f5a623; box-shadow: 0 0 0 3px rgba(245, 166, 35, .18); }
.dbq-dot.dbq-bad { background: #e5534b; box-shadow: 0 0 0 3px rgba(229, 83, 75, .2); }
.dbq-state-text { color: #e8eaed; }
.dbq-profile { color: #8b929b; font-size: 11.5px; word-break: break-all; }

.dbq-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dbq-btn { appearance: none; border: 1px solid #333a44; background: #20242b; color: #e8eaed;
  border-radius: 8px; padding: 6px 11px; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .06s ease; }
.dbq-btn:hover:not(:disabled) { background: #272d36; border-color: #3f4956; }
.dbq-btn:active:not(:disabled) { transform: translateY(1px); }
.dbq-btn:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.dbq-btn:disabled { opacity: .45; cursor: not-allowed; }
.dbq-btn.dbq-primary { border-color: #3b82f6; background: #2563eb; color: #fff; }
.dbq-btn.dbq-primary:hover:not(:disabled) { background: #2f6ff0; border-color: #60a5fa; }
.dbq-btn.dbq-dirty { border-color: #f5a623; background: #3a2c15; color: #ffd79a; }
.dbq-dirty-flag { color: #f5a623; font-size: 12px; }

.dbq-models { display: flex; flex-direction: column; gap: 6px; }
.dbq-model { display: flex; align-items: flex-start; gap: 9px; padding: 7px 10px; cursor: pointer;
  border: 1px solid #20242b; border-radius: 8px; background: #13161b;
  transition: background .15s ease, border-color .15s ease; }
.dbq-model:hover { background: #161a20; border-color: #2b323c; }
.dbq-model input[type=checkbox] { margin: 2px 0 0; flex: none; accent-color: #4a9eff; }
.dbq-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dbq-model-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbq-badge { font-size: 11px; color: #9fb2c8; background: #1e242c; border: 1px solid #2f3641;
  border-radius: 999px; padding: 0 7px; }
.dbq-model-desc { color: #9aa0a6; font-size: 11px; }
.dbq-saved { color: #7fd18a; font-size: 12px; }
.dbq-error { color: #ff9d99; font-size: 12px; }

@media (prefers-reduced-motion: reduce) {
  .dbq-fill, .dbq-btn, .dbq-row, .dbq-model { transition: none; }
}
`