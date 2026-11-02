import { $ as DOUBAO_PROVIDER, A as probeAccount, B as invalidateCredentialCache, C as chat, D as extractModel, E as describeDoubaoFailure, F as REQUIRED_COOKIE_NAMES, G as DEEP_THINK_ON, H as CHAT_AGENT_MODE, I as decodeCookiePlaintext, J as DOUBAO_DEFAULT_MODEL_ID, K as DEFAULT_REASONING_LEVEL_ID, L as decryptCookieValue, M as taskModeEnabled, N as taskWorkspaceOf, O as invalidateRenewals, P as CREDENTIAL_TTL_MS, Q as DOUBAO_MODELS, R as describeProfileLocation, S as buildQueryUrl, T as collectBlocks, U as CREATION_BLOCK_TYPE, V as loadDoubaoCredentials, W as DEEP_THINK_OFF, X as DOUBAO_IMAGE_MODEL_NAME, Y as DOUBAO_IMAGE_MODEL_ID, Z as DOUBAO_MAX_TOKENS, _ as applyRenewals, a as invalidateQuotaCache, at as TASK_AGENT_MODE, b as buildGeneralTaskParam, c as ACCOUNT_ENDPOINT, ct as TASK_SANDBOX_AUTH_ALLOW_ALL, d as DEFAULT_BOT_ID, dt as enabledModelsOf, et as DOUBAO_PROVIDER_DISPLAY_NAME, f as DOUBAO_ERROR_HINTS, ft as findDoubaoModel, g as RUNTIME_VERSION, h as QUOTA_ENDPOINT, ht as needDeepThinkValue, i as formatDuration, it as SKILL_CARRIER_MODEL_ID, j as streamChat, k as parseFrames, l as CHAT_ENDPOINT, lt as discoverDoubaoModels, m as DoubaoUpstreamError, mt as inputSkillOf, n as fetchQuota, nt as DOUBAO_SKILLS, o as millisUntilReset, ot as TASK_RUNTIME_CLOUD_VM, p as DOUBAO_VERSION, pt as findReasoningLevel, q as DOUBAO_CONTEXT_WINDOW, r as findWindow, rt as DOUBAO_UNAVAILABLE_MODELS, s as normalizeWindow, st as TASK_RUNTIME_LOCAL_PC, t as QUOTA_TTL_MS, tt as DOUBAO_REASONING_LEVELS, u as CLIENT_PARAMS, ut as doubaoCatalogEntries, v as assembleReplyText, w as classifyDoubaoFailure, x as buildHeaders, y as buildChatBody, z as findDoubaoUserDataDir } from "./doubao-quota-4h4qr42s.js";
import { a as registerDoubaoQuotaRoute, c as createDoubaoAdapter, i as registerDoubaoCatalogRoute, n as DOUBAO_QUOTA_PATH, o as createDoubaoShim, r as doubaoQuotaView, s as DOUBAO_STREAM_IDLE_TIMEOUT_MS, t as DOUBAO_CATALOG_PATH } from "./doubao-status-D8yDR4Bh.js";
import z from "@deepseek-ai/schemastery";
//#region src/doubao-config.ts
/**
* Persisted settings for the Doubao plugin.
*
* ONE field on purpose. Doubao takes no credentials, no region, no pool and no
* multipliers — the only thing a user can meaningfully configure is which catalog
* entries appear in DSH's model picker.
*
* IMPORTANT: the schema lives in its own module so the browser half can mirror
* the field name without importing anything Node-side. The Loader reads `Config`
* from the plugin entry, which re-exports this.
*
* @module dsh-connect-doubao/config
*/
/** The single settings field. Mirrored by the card as `enabledModelIds`. */
const ENABLED_MODEL_IDS_FIELD = "enabledModelIds";
/** Whether the user has ever saved a selection (i.e. the field is not the default). */
function isConfigured(config) {
	return enabledIdsOf(config) !== void 0;
}
/**
* The settings SCHEMA the Loader reads.
*
* It MUST be a real schemastery schema: Cordis calls `.validate()` on it while
* resolving the entry's config, so a plain object literal throws
* `TypeError: Cannot read properties of undefined (reading 'validate')` and the
* Loader reports `1 entry did not activate` — the plugin then contributes
* nothing at all (no provider, no routes), with only that one warning to show
* for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
*
* schemastery is a peer dependency resolved from the Harness at runtime and is
* never bundled (see tsdown.config.ts).
*/
const Config = z.object({ enabledModelIds: z.array(z.string()).default([]).description("Catalog ids enabled in the DSH model picker. Doubao routes upstream by content, so this selects which entries are offered, never which model answers. Empty means \"not yet configured\" and serves the whole catalog.") });
/**
* The ticked ids, or `undefined` when the field is ABSENT.
*
* The absent case is what `enabledModelsOf` keys off to mean "never
* configured"; a present-but-empty array is a real (empty) selection.
*/
function enabledIdsOf(config) {
	const value = config?.enabledModelIds;
	if (!Array.isArray(value)) return void 0;
	return value.filter((entry) => typeof entry === "string");
}
/**
* The ids the adapter should filter by, or `undefined` for "serve everything".
*
* Normalises the schemastery default (`[]`, meaning not-yet-configured) into
* the `undefined` that `enabledModelsOf` reads as "serve the whole catalog".
* Without this the default would read as a user who ticked nothing, and a
* first-run install would show an empty model picker.
*/
function effectiveIds(config) {
	const ids = enabledIdsOf(config);
	if (ids === void 0 || ids.length === 0) return void 0;
	return ids;
}
//#endregion
//#region src/index.ts
/**
* DSH Connect Doubao — plugin entrypoint.
*
* Assembles three pieces and hands them to the Harness LLM seam:
*
*   createDoubaoShim()         loopback HTTP surface + Doubao dialect
*   createDoubaoAdapter()      pi-ai provider registered into ctx.llm
*   registerDoubaoQuotaRoute   read-only quota view for the settings card
*
* The model catalog is STATIC and REAL: Doubao accepts an explicit
* `model_item_key`, so selecting an entry genuinely selects that model. See
* `doubao-catalog.ts` for the four verified keys and the reasoning-effort axis.
*
* 参考：dsh-connect-workbuddy 的 provider 注册链路（adapter + 可配置 provider +
*   模型发现 + webServer 只读路由），结构参照其做法。
*
* @module dsh-connect-doubao
*/
const PLUGIN_ID = "dsh-connect-doubao";
const PLUGIN_NAME = "DSH Connect Doubao";
/**
* Settings namespace for this provider's configurable entry.
*
* DEPRECATED as a name to use: the Host resolves a provider's namespace by
* EXACT match against the Loader entry id, which a profile chooses. Use
* {@link settingsNamespaceOf}, which reads the entry the Loader actually made.
* Kept as a documented fallback for hosts that expose no entry id.
*/
const DOUBAO_SETTINGS_NS = "llm:doubao";
/**
* Stable Cordis plugin name.
*
* A bare `apply` export (not a `plugin = { ... }` object): the Loader reads
* `name` / `inject` / `Config` / `apply` as named exports of the entry module.
*/
const name = PLUGIN_NAME;
/**
* Services required before the provider may register.
*
* `inject: ['llm']` is REQUIRED, not decorative. Cordis only exposes a service
* to a plugin that declared it, and touching `ctx.llm` without the declaration
* throws `cannot get property "llm" without inject` from inside `apply()` — which
* takes the whole plugin down silently: no provider, no quota route, and only a
* log line to show for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
*
* `webServer` is deliberately NOT listed: it mounts later, and on Desktop it may
* never appear, so listing it would hold the entire plugin back forever. The
* quota route waits on a NESTED `ctx.inject(['webServer'], ...)` instead.
*
* `settings` is a soft probe (`ctx.get`), not an inject entry: the settings
* surface differs by host line, and Cordis' gate is hard enough that naming a
* service this host does not provide stops `apply` from ever running.
*/
const inject = ["llm"];
/**
* The namespace the HOST actually serves this plugin's config under.
*
* The Host resolves a provider's namespace by EXACT match, and the namespace it
* serves is the Loader entry id — which a profile may mount as
* `dsh-connect-doubao` or, as the live Desktop host does, as an include. A
* guessed name that misses makes the config entry read as unconfigured and the
* model's settings disappear. So ask the Loader entry, with the declared id as
* the documented fallback.
*/
function settingsNamespaceOf(ctx) {
	return (ctx.fiber?.entry)?.options?.id ?? "dsh-connect-doubao";
}
/**
* Wire the provider and the read-only routes.
*
* `apply` wires every disposer into one `ctx.effect`, so unloading the plugin
* releases the shim's port, the adapter, the directory entry, the discovery
* callback and the HTTP routes — nothing outlives the plugin.
*/
function apply(ctx, config = { enabledModelIds: [] }) {
	let shim;
	let adapterRelease;
	let directoryRelease;
	let discoveryRelease;
	const settingsNs = settingsNamespaceOf(ctx);
	/**
	* Live config, replaced on every settings write.
	*
	* Cordis re-invokes nothing here: it hands `apply` the config once, so the
	* live value is what `loader/volatile-update` refreshes. Kept as a `let` so
	* the discovery closure always reads the CURRENT selection rather than the one
	* captured at registration.
	*/
	let current = config;
	try {
		shim = createDoubaoShim();
		const { adapter, invalidate, setEnabledModelIds } = createDoubaoAdapter({
			shim,
			enabledModelIds: effectiveIds(config)
		});
		adapterRelease = ctx.llm.registerAdapter([DOUBAO_PROVIDER], adapter);
		directoryRelease = ctx.llm.registerConfigurableProviders([{
			provider: DOUBAO_PROVIDER,
			displayName: DOUBAO_PROVIDER_DISPLAY_NAME,
			settingsNs,
			settingsPath: [],
			declared: false
		}]);
		ctx.effect(() => () => {
			adapterRelease?.();
			directoryRelease?.();
			discoveryRelease?.();
			shim?.close();
			shim = void 0;
		});
		invalidate();
		try {
			discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
				if (request.provider !== void 0 && request.provider !== "doubao") return [];
				return enabledModelsOf(effectiveIds(current)).map((model) => ({
					id: model.id,
					name: model.name,
					contextWindow: DOUBAO_CONTEXT_WINDOW,
					maxTokens: DOUBAO_MAX_TOKENS,
					inputModalities: ["text"]
				}));
			});
		} catch (error) {
			ctx.logger.error("dsh-connect-doubao: model discovery registration failed", error);
		}
		const settings = ctx.get("settings");
		if (settings !== void 0) try {
			ctx.effect(() => settings.configure({ auto: true }, ctx.fiber));
		} catch (error) {
			ctx.logger.error("dsh-connect-doubao: settings presentation failed", error);
		}
		const onSettingsChanged = (next) => {
			if (next !== void 0) current = next;
			setEnabledModelIds(effectiveIds(current));
			invalidate();
		};
		try {
			ctx.on("loader/volatile-update", onSettingsChanged);
		} catch {}
		ctx.inject(["webServer"], (webCtx) => {
			try {
				const disposeQuota = registerDoubaoQuotaRoute(webCtx);
				const disposeCatalog = registerDoubaoCatalogRoute(webCtx);
				ctx.effect(() => () => {
					disposeQuota();
					disposeCatalog();
				});
			} catch (error) {
				ctx.logger.error("dsh-connect-doubao: web route registration failed", error);
			}
		});
	} catch (error) {
		ctx.logger.error("dsh-connect-doubao: provider registration failed", error);
		adapterRelease?.();
		directoryRelease?.();
		discoveryRelease?.();
		shim?.close();
		shim = void 0;
	}
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { ACCOUNT_ENDPOINT, CHAT_AGENT_MODE, CHAT_ENDPOINT, CLIENT_PARAMS, CREATION_BLOCK_TYPE, CREDENTIAL_TTL_MS, Config, DEEP_THINK_OFF, DEEP_THINK_ON, DEFAULT_BOT_ID, DEFAULT_REASONING_LEVEL_ID, DOUBAO_CATALOG_PATH, DOUBAO_CONTEXT_WINDOW, DOUBAO_DEFAULT_MODEL_ID, DOUBAO_ERROR_HINTS, DOUBAO_IMAGE_MODEL_ID, DOUBAO_IMAGE_MODEL_NAME, DOUBAO_MAX_TOKENS, DOUBAO_MODELS, DOUBAO_PROVIDER, DOUBAO_PROVIDER_DISPLAY_NAME, DOUBAO_QUOTA_PATH, DOUBAO_REASONING_LEVELS, DOUBAO_SETTINGS_NS, DOUBAO_SKILLS, DOUBAO_STREAM_IDLE_TIMEOUT_MS, DOUBAO_UNAVAILABLE_MODELS, DOUBAO_VERSION, DoubaoUpstreamError, ENABLED_MODEL_IDS_FIELD, PLUGIN_ID, PLUGIN_NAME, QUOTA_ENDPOINT, QUOTA_TTL_MS, REQUIRED_COOKIE_NAMES, RUNTIME_VERSION, SKILL_CARRIER_MODEL_ID, TASK_AGENT_MODE, TASK_RUNTIME_CLOUD_VM, TASK_RUNTIME_LOCAL_PC, TASK_SANDBOX_AUTH_ALLOW_ALL, apply, applyRenewals, assembleReplyText, buildChatBody, buildGeneralTaskParam, buildHeaders, buildQueryUrl, chat, classifyDoubaoFailure, collectBlocks, createDoubaoAdapter, createDoubaoShim, decodeCookiePlaintext, decryptCookieValue, src_default as default, describeDoubaoFailure, describeProfileLocation, discoverDoubaoModels, doubaoCatalogEntries, doubaoQuotaView, effectiveIds, enabledIdsOf, enabledModelsOf, extractModel, fetchQuota, findDoubaoModel, findDoubaoUserDataDir, findReasoningLevel, findWindow, formatDuration, inject, inputSkillOf, invalidateCredentialCache, invalidateQuotaCache, invalidateRenewals, isConfigured, loadDoubaoCredentials, millisUntilReset, name, needDeepThinkValue, normalizeWindow, parseFrames, probeAccount, registerDoubaoCatalogRoute, registerDoubaoQuotaRoute, settingsNamespaceOf, streamChat, taskModeEnabled, taskWorkspaceOf };
