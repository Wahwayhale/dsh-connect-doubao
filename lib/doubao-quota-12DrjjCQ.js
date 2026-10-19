import { createRequire } from "node:module";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
//#region src/doubao-catalog.ts
/**
* Doubao model catalog.
*
* Doubao DOES let the caller pick a model. The choice travels in the request
* body at TWO mirrored locations, and upstream ignores the request if only one
* is written:
*
*   option.model_config.model_item_key       ← numeric or slug
*   option.aggregate_params.model_item_key   ← same value, same body
*
* Every id below was read off a real request the desktop app sent, not inferred.
* They are NOT interchangeable with numbers that appear elsewhere in the body:
* `aggregate_params.mode_id` is also often "3", but it means the 对话/工作 mode
* switch, NOT the Turbo model. The two are named apart throughout this codebase
* precisely because the collision is easy to fall into.
*
* ⚠️ ENCODING IS MIXED. `seed-lite-7b` is a string slug; `3`, `5` and `9` are
* numeric enum values. They travel as JSON strings either way and MUST be
* forwarded verbatim — never parsed to a number, or the slug is lost.
*
* 推理强度 (reasoning effort) is a separate axis. It travels as
* `reasoning_effort` (mirrored like the model) and, redundantly, as
* `need_deep_think = 10000 + level` plus `ext.use_deep_think`. See
* {@link DOUBAO_REASONING_LEVELS} for which levels are verified.
*
* @module dsh-connect-doubao/catalog
*/
/** Provider route id this bundle owns. */
const DOUBAO_PROVIDER = "doubao";
/** Shown in the DSH model picker. */
const DOUBAO_PROVIDER_DISPLAY_NAME = "豆包（Doubao）";
/** How much context a Doubao conversation holds. */
const DOUBAO_CONTEXT_WINDOW = 256e3;
/** Generous output ceiling; the subscription quota, not this, is the real bound. */
const DOUBAO_MAX_TOKENS = 32e3;
/**
* Agent mode for ordinary chat.
*
* The desktop app has a 对话/工作 switch that also lands in `agent_mode`:
* ordinary chat sends 1, work mode sends 2. Only chat is implemented here.
*/
const CHAT_AGENT_MODE = 1;
const DOUBAO_REASONING_LEVELS = [
	{
		id: "low",
		name: "低",
		level: 3,
		verified: true
	},
	{
		id: "mid",
		name: "中",
		level: 4,
		verified: true
	},
	{
		id: "high",
		name: "高",
		level: 5,
		verified: true
	}
];
/** The level used when a request names none. Verified on the wire. */
const DEFAULT_REASONING_LEVEL_ID = "high";
/** Reasoning level for an id, falling back to the default. */
function findReasoningLevel(id) {
	return DOUBAO_REASONING_LEVELS.find((level) => level.id === id) ?? DOUBAO_REASONING_LEVELS.find((level) => level.id === "high");
}
/** `need_deep_think` for a reasoning level: 10000 + level, per a captured request. */
function needDeepThinkOf(level) {
	return 1e4 + level.level;
}
/**
* The six entries the desktop app publishes, with the keys it sends.
*
* Read out of the client's own `menuConfV2` cache (M10) — the configuration
* the server hands the app, not something reconstructed from the UI. Each entry
* there carries its own `reasoning_effort_config` listing 低=3 / 中=4 / 高=5,
* which is the SECOND of two independent confirmations of those values (the
* first was the UI diff in M8 续二).
*
* 「豆包 快速」 leads because it is what `default_select_mode_map.chat` points
* at, so an unconfigured install reproduces the app's own default rather than
* something that merely happens to work.
*/
const DOUBAO_MODELS = [
	{
		id: "0",
		name: "豆包 快速",
		reasoning: true
	},
	{
		id: "seed-lite-7b",
		name: "豆包 2.1 Lite",
		badge: "0921 新版",
		reasoning: true
	},
	{
		id: "3",
		name: "豆包 2.1 Turbo",
		badge: "专家",
		reasoning: true
	},
	{
		id: "5",
		name: "豆包 2.1 Pro",
		reasoning: true
	},
	{
		id: "4",
		name: "豆包 2.1 Turbo",
		badge: "即将下线",
		reasoning: true
	},
	{
		id: "9",
		name: "自动",
		reasoning: true
	}
];
/**
* The model used when a request names none.
*
* 「豆包 快速」 is the app's own chat-mode default — `menuConfV2`'s
* `default_select_mode_map.chat` points at it — so leaving it unnamed here
* reproduces what the desktop app would have done. Spelled out rather than
* taken from `DOUBAO_MODELS[0]`, so reordering the list cannot silently change
* which model an unconfigured session gets.
*/
const DOUBAO_DEFAULT_MODEL_ID = "0";
/**
* Catalog entry for a model id, falling back to {@link DOUBAO_DEFAULT_MODEL_ID}.
*
* An id the catalog does not know resolves to the default rather than throwing:
* a stale id in a saved session should degrade to a working model, not break
* the request. `describeRequestedModel` in the shim is what surfaces the miss.
*/
function findDoubaoModel(id) {
	return DOUBAO_MODELS.find((model) => model.id === id) ?? DOUBAO_MODELS.find((model) => model.id === "0");
}
function discoverDoubaoModels() {
	return DOUBAO_MODELS.map((model) => ({
		id: model.id,
		name: model.badge === void 0 ? model.name : `${model.name} · ${model.badge}`,
		contextWindow: DOUBAO_CONTEXT_WINDOW,
		maxTokens: DOUBAO_MAX_TOKENS,
		inputModalities: ["text"],
		reasoning: model.reasoning
	}));
}
/**
* Narrow the catalog to the ids the user has ticked.
*
* Selecting an entry now genuinely selects a model, so this is a real
* restriction — but it still only decides WHICH ENTRIES APPEAR IN DSH's MODEL
* PICKER; the per-request choice is made by the DSH session, not here.
*
* `undefined` (never configured) serves the whole catalog: a first-run install
* must show its models. Ids that no longer exist are dropped.
*/
function enabledModelsOf(enabledIds) {
	if (enabledIds === void 0 || enabledIds.length === 0) return [...DOUBAO_MODELS];
	const wanted = new Set(enabledIds);
	return DOUBAO_MODELS.filter((model) => wanted.has(model.id));
}
function doubaoCatalogEntries() {
	return DOUBAO_MODELS.map((model) => ({
		id: model.id,
		name: model.name,
		badge: model.badge ?? null,
		reasoningLevels: DOUBAO_REASONING_LEVELS.map((level) => ({
			id: level.id,
			name: level.name,
			level: level.level,
			verified: level.verified
		}))
	}));
}
//#endregion
//#region src/doubao-auth.ts
/**
* Doubao credential extraction.
*
* The Doubao desktop app is a Chromium fork. Its sign-in lives in the
* standard Chromium cookie jar, so an already-signed-in app can serve as the
* credential source for an external client without any interactive login.
*
* Decryption chain (verified end-to-end against Doubao 2.29.10):
*
*   <User Data>\Local State
*     -> os_crypt.encrypted_key            (base64 string)
*     -> strip the leading b"DPAPI" magic   (5 bytes)
*     -> CryptUnprotectData                 (Windows DPAPI, user scope)
*     -> 32-byte master key
*
*   <User Data>\Default\Network\Cookies     (SQLite)
*     -> encrypted_value, scheme "v10"
*     -> AES-256-GCM(nonce = value[3..15], aad = none)
*     -> plaintext = sha256(host_key).digest()[0..N) || cookie_value
*     -> strip that N-byte host prefix
*
* The N-byte prefix is the part that is easy to get wrong. Chrome 130+ binds
* each plaintext to its host with `sha256(host_key)`; older builds stored the
* bare value. Guessing wrong yields a value with trailing binary garbage,
* which fails far downstream as an opaque "session expired" from the server.
* `decodeCookiePlaintext` therefore adapts N instead of hardcoding it.
*
* SECURITY: credentials live in this process's memory only. Nothing here is
* ever written to disk, exported, or logged. Callers must treat the returned
* values as opaque secrets.
*/
const require_ = createRequire(import.meta.url);
/** Cookie lifetime in the process cache. Doubao rotates `bd_sso_hi3jfd` itself. */
const CREDENTIAL_TTL_MS = 6e5;
/**
* Cookie names Doubao's chat backend actually needs for authentication.
* Verified in M1/M2: this exact set authenticated while the app was closed.
*/
const REQUIRED_COOKIE_NAMES = [
	"sessionid",
	"sessionid_ss",
	"sid_tt",
	"sid_guard",
	"uid_tt",
	"ttwid",
	"odin_tt",
	"passport_csrf_token",
	"s_v_web_id"
];
const COOKIE_HOST_SUFFIXES = ["doubao.com", "bytedance.com"];
const DPAPI_MAGIC = Buffer.from("DPAPI", "ascii");
/**
* Call CryptUnprotectData via a short-lived PowerShell child process.
*
* Node has no built-in DPAPI binding and the plugin must not pull in a native
* addon, so we shell out to the Windows Data Protection API. The master key
* travels back over stdout and never touches disk.
*/
function dpapiUnprotect(cipher) {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = \"SilentlyContinue\"",
		"$cs = 'using System; using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential)] public struct DshDataBlob { public int cbData; public IntPtr pbData; } public static class DshCrypt { [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptUnprotectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); }'",
		"Add-Type -TypeDefinition $cs",
		"$bytes = [System.Convert]::FromBase64String($env:DSH_DOUBAO_DPAPI_BLOB)",
		"$len = [int]$bytes.Length",
		"$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)",
		"[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, $len)",
		"$inBlob = New-Object DshDataBlob",
		"$inBlob.cbData = $len",
		"$inBlob.pbData = $mem",
		"$outBlob = New-Object DshDataBlob",
		"$ok = [DshCrypt]::CryptUnprotectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"if (-not $ok) { [Console]::Out.Write('DPAPI_CALL_FAILED'); exit 3 }",
		"$res = New-Object byte[] $outBlob.cbData",
		"[Runtime.InteropServices.Marshal]::Copy($outBlob.pbData, $res, 0, $outBlob.cbData)",
		"[Console]::Out.Write([System.Convert]::ToBase64String($res))",
		""
	].join("\r\n");
	const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-dpapi-"));
	const scriptPath = join(scratch, "unprotect.ps1");
	try {
		writeFileSync(scriptPath, script, "utf8");
		const result = spawnSync("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath
		], {
			encoding: "utf8",
			maxBuffer: 1 << 24,
			windowsHide: true,
			env: {
				...process.env,
				DSH_DOUBAO_DPAPI_BLOB: cipher.toString("base64")
			}
		});
		const stdout = result.stdout ?? "";
		if (stdout.trim() === "") {
			const stderr = result.stderr ?? "";
			throw new Error(`Windows DPAPI helper produced no output (status=${result.status}, stdout=${JSON.stringify(stdout.slice(0, 120))}, stderr=${JSON.stringify(stderr.slice(-400))})`);
		}
		for (const line of stdout.split(/\r?\n/).reverse()) {
			const candidate = line.trim();
			if (!candidate || candidate.startsWith("#") || candidate.startsWith("<")) continue;
			if (candidate === "DPAPI_CALL_FAILED") throw new Error("Windows DPAPI rejected the blob (CryptUnprotectData returned false)");
			const decoded = Buffer.from(candidate, "base64");
			if (decoded.length > 0) return decoded;
		}
		throw new Error("DPAPI helper returned no usable output");
	} finally {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	}
}
/**
* Strip the host-binding prefix from a decrypted cookie plaintext.
*
* `N` is discovered by matching the plaintext against `sha256(host_key)` at
* decreasing prefix lengths. 32 is Chrome 130+; 0 covers legacy builds that
* stored the bare value. We never guess: an unmatched plaintext is an error,
* because silently returning a corrupt value would surface later as an opaque
* server-side "login invalid" instead of an actionable local failure.
*/
function decodeCookiePlaintext(plaintext, hostKey) {
	const digest = createHash("sha256").update(hostKey, "utf8").digest();
	for (const n of [
		32,
		24,
		16,
		0
	]) {
		if (n === 0) break;
		if (plaintext.length >= n && plaintext.subarray(0, n).equals(digest.subarray(0, n))) return plaintext.subarray(n).toString("latin1");
	}
	if (plaintext.length === 0) return "";
	let printable = true;
	for (const byte of plaintext) if (byte < 32 || byte > 126) {
		printable = false;
		break;
	}
	if (printable) return plaintext.toString("latin1");
	throw new Error("cookie plaintext matches no known host prefix and is not printable ASCII; this Chromium fork may use a different binding scheme");
}
/** Decrypt one `v10` cookie value with the profile master key. */
function decryptCookieValue(masterKey, encryptedValue, hostKey) {
	if (encryptedValue.length < 3) return "";
	const scheme = encryptedValue.subarray(0, 3).toString("latin1");
	if (scheme === "v10" || scheme === "v11") {
		const nonce = encryptedValue.subarray(3, 15);
		const tagAndCiphertext = encryptedValue.subarray(15);
		const tag = tagAndCiphertext.subarray(tagAndCiphertext.length - 16);
		const ciphertext = tagAndCiphertext.subarray(0, tagAndCiphertext.length - 16);
		const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
		decipher.setAuthTag(tag);
		return decodeCookiePlaintext(Buffer.concat([decipher.update(ciphertext), decipher.final()]), hostKey);
	}
	if (scheme === "v20") throw new Error("cookie uses the v20 App-Bound scheme, which requires the Doubao app process to decrypt it; run the request from inside the app instead");
	throw new Error(`unsupported cookie encryption scheme "${scheme}"`);
}
/** Locate the Doubao Chromium profile directory on this machine. */
function findDoubaoUserDataDir() {
	if (process.platform !== "win32") return void 0;
	const bases = [
		process.env.LOCALAPPDATA,
		process.env.APPDATA,
		"C:\\Users"
	].filter((x) => Boolean(x));
	const candidates = [];
	for (const base of bases) {
		candidates.push(join(base, "Doubao", "User Data"));
		if (base.endsWith("Users")) try {
			const { readdirSync } = require_("node:fs");
			for (const user of readdirSync(base)) candidates.push(join(base, user, "AppData", "Local", "Doubao", "User Data"));
		} catch {}
	}
	for (const candidate of candidates) if (existsSync(join(candidate, "Default", "Network", "Cookies"))) return candidate;
}
/**
* Read rows from the cookie jar.
*
* Chromium holds an exclusive lock on the live database, so the file is copied
* to a temp directory first and that copy is destroyed before returning. The
* original profile is only ever read.
*/
function readCookieRows(userDataDir) {
	const source = join(userDataDir, "Default", "Network", "Cookies");
	const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-cookie-"));
	const copy = join(scratch, "Cookies.db");
	try {
		copyFileSync(source, copy);
		const { DatabaseSync } = require_("node:sqlite");
		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			return db.prepare("SELECT host_key, name, encrypted_value FROM cookies WHERE encrypted_value IS NOT NULL").all().map((r) => ({
				host: String(r.host_key),
				name: String(r.name),
				encrypted: Buffer.from(r.encrypted_value)
			}));
		} finally {
			db.close();
		}
	} finally {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	}
}
let cached$1;
/**
* Decrypt the Doubao session from the local app profile.
*
* The result is cached in process memory for `CREDENTIAL_TTL_MS`. Nothing is
* persisted. A failure is reported as `{ ok: false, reason }` rather than
* thrown so the provider can surface an actionable message.
*/
function loadDoubaoCredentials(options = {}) {
	const now = Date.now();
	if (!options.force && cached$1 && now - cached$1.at < 6e5) return cached$1.credentials;
	let credentials;
	try {
		const userDataDir = findDoubaoUserDataDir();
		if (!userDataDir) credentials = {
			ok: false,
			reason: "Doubao user profile not found. Expected <UserProfile>\\AppData\\Local\\Doubao\\User Data.",
			header: "",
			pairs: /* @__PURE__ */ new Map()
		};
		else credentials = decryptFromProfile(userDataDir);
	} catch (error) {
		credentials = {
			ok: false,
			reason: `failed to read Doubao credentials: ${error.message}`,
			header: "",
			pairs: /* @__PURE__ */ new Map()
		};
	}
	cached$1 = {
		at: now,
		credentials
	};
	return credentials;
}
function decryptFromProfile(userDataDir) {
	if (process.platform !== "win32") return {
		ok: false,
		reason: "Doubao credential extraction is only supported on Windows.",
		header: "",
		pairs: /* @__PURE__ */ new Map()
	};
	const encodedKey = JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8")).os_crypt?.encrypted_key;
	if (!encodedKey) return {
		ok: false,
		reason: "Local State has no os_crypt.encrypted_key.",
		header: "",
		pairs: /* @__PURE__ */ new Map()
	};
	const keyBlob = Buffer.from(encodedKey, "base64");
	if (keyBlob.subarray(0, 5).toString("latin1") !== DPAPI_MAGIC.toString("latin1")) return {
		ok: false,
		reason: "encrypted_key is missing the DPAPI prefix.",
		header: "",
		pairs: /* @__PURE__ */ new Map()
	};
	const masterKey = dpapiUnprotect(keyBlob.subarray(5));
	if (masterKey.length !== 32) return {
		ok: false,
		reason: `master key has unexpected length ${masterKey.length}.`,
		header: "",
		pairs: /* @__PURE__ */ new Map()
	};
	try {
		const rows = readCookieRows(userDataDir);
		const pairs = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const host = row.host.toLowerCase();
			if (!COOKIE_HOST_SUFFIXES.some((suffix) => host === `.${suffix}` || host.endsWith(`.${suffix}`))) continue;
			try {
				pairs.set(row.name, decryptCookieValue(masterKey, row.encrypted, row.host));
			} catch {}
		}
		const missing = REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name));
		if (missing.length > 0) return {
			ok: false,
			reason: `Doubao session cookies missing (${missing.join(", ")}). Sign in to the Doubao app and retry.`,
			header: "",
			pairs
		};
		return {
			ok: true,
			header: [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
			pairs
		};
	} finally {
		masterKey.fill(0);
	}
}
/** Drop the in-memory cache. Used by tests and by explicit user refresh. */
function invalidateCredentialCache() {
	cached$1 = void 0;
}
/** Parent directory of the profile, for diagnostics only. */
function describeProfileLocation() {
	const dir = findDoubaoUserDataDir();
	return dir ? dirname(dir) : "<not found>";
}
//#endregion
//#region src/doubao-upstream.ts
/**
* Doubao upstream client.
*
* Endpoint: POST https://www.doubao.com/chat/completion
*
* Three request details decide whether the call succeeds or is challenged with
* a slider CAPTCHA (verified in M2 — getting any of them wrong silently turns a
* working session into `710022004 rate limited`):
*
*   1. User-Agent must carry the `SamanthaDoubao/<version>` suffix.
*   2. Referer must be the `chrome://doubao-chat/` scheme, NOT an https URL.
*   3. sec-ch-ua must use the real client-hints brand string.
*
* No `a_bogus` signature is required; the server accepts a cookie-authenticated
* request without it.
*
* The response is a ByteDance-specific streaming variant, NOT standard SSE.
* Frames are three lines — `id:`, `event:`, `data:` — followed by a blank
* line, so a generic `data:`-only SSE parser silently drops everything.
*/
const CHAT_ENDPOINT = "https://www.doubao.com/chat/completion";
const QUOTA_ENDPOINT = "https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/";
const ACCOUNT_ENDPOINT = "https://www.doubao.com/passport/account/info/v2/";
/**
* Client version strings. These are the desktop app build this was last
* verified against (M9), and they MOVE with every Doubao release — a newer app
* sends different values here and a very old one will eventually stop being
* accepted. Re-check them whenever Doubao auto-updates; the risk-control layer
* compares them against the session it sees.
*/
const DOUBAO_VERSION = "2.31.4";
const RUNTIME_VERSION = "3.39.0";
/**
* Frozen, non-secret client identity.
*
* These are constant across Doubao sessions and are NOT credentials. Keeping
* them fixed is what makes an external request look like the same install to
* the risk-control layer.
*/
const CLIENT_PARAMS = {
	aid: "582478",
	real_aid: "582478",
	version_code: "20800",
	pc_version: DOUBAO_VERSION,
	device_id: "2697515174213273",
	tea_uuid: "2697515174213273",
	web_id: "7677868049198630415",
	fp: "verify_2697515174213273",
	chromium_version: "147.0.7727.149",
	runtime_version: RUNTIME_VERSION,
	channel: "win",
	language: "zh",
	region: "CN",
	sys_region: "CN",
	tz_name: "Asia/Shanghai",
	pkg_type: "release_version",
	client_platform: "pc_client",
	device_platform: "web",
	doubao_device_platform: "desktop",
	web_platform: "desktop",
	samantha_web: "1",
	"use-olympus-account": "1"
};
/** The default Doubao assistant; content routing means the model is chosen server-side. */
const DEFAULT_BOT_ID = "7338286299411103781";
/** Headers that make an external request indistinguishable from the app's. */
function buildHeaders(credentials, extra = {}) {
	return {
		"User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${DOUBAO_VERSION}`,
		Referer: "chrome://doubao-chat/",
		accept: "*/*",
		"accept-language": "zh-CN,zh;q=0.9",
		"sec-ch-ua": "\"Chromium\";v=\"147\", \"Not.A/Brand\";v=\"8\"",
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": "\"Windows\"",
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
		"agw-js-conv": "str",
		"x-flow-trace": `${randomUUID().replace(/-/g, "")}-${randomUUID().replace(/-/g, "")}-01`,
		"last-event-id": "undefined",
		cookie: applyRenewals(credentials.header),
		...extra
	};
}
function buildQueryUrl(endpoint, msToken) {
	const params = new URLSearchParams({
		...CLIENT_PARAMS,
		web_tab_id: randomUUID()
	});
	if (msToken) params.set("msToken", msToken);
	return `${endpoint}?${params.toString()}`;
}
var DoubaoUpstreamError = class extends Error {
	code;
	rateLimited;
	constructor(message, code, rateLimited = false) {
		super(message);
		this.code = code;
		this.rateLimited = rateLimited;
		this.name = "DoubaoUpstreamError";
	}
};
/**
* Build the request body Doubao's chat endpoint expects.
*
* The model and the reasoning effort are each written at TWO locations, because
* that is what the app does and what upstream reads. Writing only one is
* silently ignored — the request succeeds and the answer comes from whatever
* the server last used.
*
* `general_task_param` is deliberately absent: it carries the desktop app's
* local sandbox and workspace paths, none of which apply to an external client,
* and the endpoint has been observed answering correctly without it.
*/
function buildChatBody(prompt, options = {}) {
	const model = findDoubaoModel(options.modelKey);
	const level = findReasoningLevel(options.reasoningLevel);
	const agentMode = options.agentMode ?? 1;
	const needDeepThink = needDeepThinkOf(level);
	return {
		messages: [{
			local_message_id: randomUUID(),
			message_status: 0,
			content_block: [{
				block_type: 1e4,
				block_id: randomUUID(),
				parent_id: "",
				meta_info: [],
				append_fields: [],
				content: {
					text_block: {
						text: prompt,
						icon_url: "",
						icon_url_dark: "",
						summary: ""
					},
					pc_event_block: ""
				}
			}]
		}],
		option: {
			send_message_scene: "",
			create_time_ms: Date.now(),
			collect_id: "",
			is_audio: false,
			answer_with_suggest: false,
			agent_mode: agentMode,
			tts_switch: false,
			need_deep_think: needDeepThink,
			click_clear_context: false,
			from_suggest: false,
			is_regen: false,
			is_replace: false,
			is_from_click_option: false,
			is_from_click_softlink: false,
			disable_sse_cache: false,
			select_text_action: "",
			is_select_text: false,
			sse_recv_event_options: { support_chunk_delta: true },
			model_config: {
				model_item_key: model.id,
				model_extra_params: {
					memory_profile: "256k",
					total_window_size: String(DOUBAO_CONTEXT_WINDOW)
				},
				reasoning_effort: level.level
			},
			aggregate_params: {
				model_item_key: model.id,
				agent_mode: String(agentMode),
				reasoning_effort: String(level.level),
				provider_id: ""
			}
		},
		client_meta: {
			local_conversation_id: `local_${randomUUID()}`,
			conversation_id: options.conversationId ?? "",
			bot_id: DEFAULT_BOT_ID,
			last_section_id: "",
			last_message_index: null
		},
		user_context: [],
		ext: {
			use_deep_think: String(needDeepThink),
			agent_mode: String(agentMode),
			is_finish: "1",
			commerce_credit_config_enable: "0"
		}
	};
}
/**
* Parse ByteDance's three-line streaming frames out of a decoded text buffer.
*
* A frame is `id:` then `event:` then `data:` then a blank line. Standard SSE
* also permits comment lines (`:`), so those are skipped. Returns the frames
* plus whatever tail did not yet form a complete frame.
*/
function parseFrames(buffer) {
	const frames = [];
	let rest = buffer;
	while (true) {
		const boundary = rest.search(/\r?\n\r?\n/);
		if (boundary < 0) break;
		const block = rest.slice(0, boundary);
		rest = rest.slice(boundary).replace(/^\r?\n\r?\n/, "");
		const frame = { data: "" };
		const dataLines = [];
		for (const line of block.split(/\r?\n/)) {
			if (!line || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "id") frame.id = value;
			else if (field === "event") frame.event = value;
			else if (field === "data") dataLines.push(value);
		}
		if (dataLines.length > 0 || frame.event) {
			frame.data = dataLines.join("\n");
			frames.push(frame);
		}
	}
	return {
		frames,
		rest
	};
}
/**
* Collect assistant text and routing metadata from a decoded frame payload.
*
* Doubao nests message content in several differently-shaped envelopes
* depending on the event, so this walks any `text` field it finds rather than
* assuming one fixed path.
*/
function harvestText(node, into) {
	if (Array.isArray(node)) {
		for (const item of node) harvestText(item, into);
		return;
	}
	if (node === null || typeof node !== "object") return;
	for (const [key, value] of Object.entries(node)) if ((key === "text" || key === "content" || key === "delta") && typeof value === "string") into.out.push(value);
	else harvestText(value, into);
}
/** Read the model identifier the server actually used for a reply. */
function extractModel(payload) {
	const seen = /* @__PURE__ */ new Set();
	const walk = (node) => {
		if (node === null || typeof node !== "object") return void 0;
		if (Array.isArray(node)) {
			for (const item of node) {
				const found = walk(item);
				if (found) return found;
			}
			return;
		}
		const record = node;
		for (const key of [
			"model",
			"model_name",
			"model_id",
			"llm_model_type",
			"model_type"
		]) {
			const value = record[key];
			if (typeof value === "string" && value && !seen.has(value)) {
				seen.add(value);
				return value;
			}
			if (typeof value === "number" && value) {
				const text = String(value);
				if (!seen.has(text)) {
					seen.add(text);
					return text;
				}
			}
		}
		for (const value of Object.values(record)) {
			const found = walk(value);
			if (found) return found;
		}
	};
	return walk(payload);
}
/** True when the reply came from a reasoning-capable model. */
function extractThinking(payload) {
	const record = payload;
	const ext = record?.message?.ext ?? record?.ext;
	if (ext && typeof ext === "object") {
		const useDeepThink = ext.use_deep_think;
		if (useDeepThink === "1" || useDeepThink === 1) return true;
		if (typeof useDeepThink === "string" && useDeepThink !== "0") return true;
	}
	return false;
}
/**
* Stream one chat completion and return the assembled reply.
*
* Rejects with `DoubaoUpstreamError` when the server answers with a business
* error frame — notably `710022004 rate limited`, which is risk control asking
* for a slider CAPTCHA rather than an authentication failure.
*/
async function streamChat(prompt, options = {}) {
	const credentials = options.credentials ?? loadDoubaoCredentials();
	if (!credentials.ok) throw new DoubaoUpstreamError(credentials.reason ?? "Doubao credentials unavailable.");
	const missing = REQUIRED_COOKIE_NAMES.filter((name) => !credentials.pairs.get(name));
	if (missing.length > 0) throw new DoubaoUpstreamError(`Doubao session cookies missing: ${missing.join(", ")}`);
	const msToken = credentials.pairs.get("msToken");
	const url = buildQueryUrl(CHAT_ENDPOINT, msToken);
	const headers = buildHeaders(credentials, { "content-type": "application/json" });
	const body = JSON.stringify(buildChatBody(prompt, options));
	const response = await fetch(url, {
		method: "POST",
		headers,
		body,
		...options.signal ? { signal: options.signal } : {}
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new DoubaoUpstreamError(`Doubao chat request failed with HTTP ${response.status}. ${detail.slice(0, 200)}`);
	}
	absorbSetCookies(response.headers);
	return await consumeStream(response, options.callbacks);
}
const renewals = /* @__PURE__ */ new Map();
/**
* Drop every rotated cookie this module has absorbed.
*
* MUST be called together with `invalidateCredentialCache()`. The two caches
* hold halves of one credential: the auth cache holds what was decrypted from
* disk, and `renewals` holds what the server rotated onto us afterwards
* (`x-ms-token`, `bd_sso_hi3jfd`). Clearing one without the other leaves the
* stale half behind — after a credential refresh the freshly-read cookies
* would immediately be overwritten by values from the previous session, and
* the user would be told to sign in again for no real reason.
*/
function invalidateRenewals() {
	renewals.clear();
}
/** Record rotated cookies (`x-ms-token`, `bd_sso_hi3jfd`) for the next request. */
function absorbSetCookies(headers) {
	const msToken = headers.get("x-ms-token");
	if (msToken) renewals.set("msToken", msToken);
	const setCookie = headers.get("set-cookie");
	if (!setCookie) return;
	for (const part of setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/)) {
		const [pair] = part.split(";");
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (name && value) renewals.set(name, value);
	}
}
/** Cookie header with any rotated values overlaid. Values never leave memory. */
function applyRenewals(header) {
	if (renewals.size === 0) return header;
	const pairs = /* @__PURE__ */ new Map();
	for (const part of header.split(/;\s*/)) {
		const eq = part.indexOf("=");
		if (eq > 0) pairs.set(part.slice(0, eq).trim(), part.slice(eq + 1));
	}
	for (const [name, value] of renewals) pairs.set(name, value);
	return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function consumeStream(response, callbacks) {
	const reader = response.body?.getReader();
	if (!reader) throw new DoubaoUpstreamError("Doubao returned an empty response body.");
	const decoder = new TextDecoder();
	let buffer = "";
	const texts = [];
	let conversationId;
	let messageId;
	let model;
	let thinking = false;
	let lastEventId;
	let ended = false;
	const handle = (frame) => {
		const name = frame.event ?? "";
		if (name && callbacks?.onEvent) callbacks.onEvent(name);
		if (frame.id) lastEventId = frame.id;
		if (!frame.data) return;
		let payload;
		try {
			payload = JSON.parse(frame.data);
		} catch {
			return;
		}
		if (name === "STREAM_ERROR") {
			const record = payload;
			const code = record.error_code;
			const message = record.error_msg ?? "unknown stream error";
			const rateLimited = code === 710022004 || /rate limit/i.test(message);
			throw new DoubaoUpstreamError(rateLimited ? "Doubao risk control challenged this request (710022004). Slow down and retry later." : `Doubao stream error ${code ?? "?"}: ${message}`, code, rateLimited);
		}
		if (name === "SSE_ACK") {
			const ack = payload;
			conversationId = ack.ack_client_meta?.conversation_id ?? conversationId;
			messageId = ack.query_list?.[0]?.question_id ?? messageId;
			return;
		}
		if (name === "FULL_MSG_NOTIFY" || name === "STREAM_MSG_NOTIFY") {
			messageId = payload.message?.message_id ?? messageId;
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			return;
		}
		if (name === "STREAM_CHUNK" || name === "CHUNK_DELTA") {
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			const acc = { out: [] };
			harvestText(payload, acc);
			for (const text of acc.out) {
				if (!text) continue;
				if (callbacks?.onText) callbacks.onText(text);
				texts.push(text);
			}
			return;
		}
		if (name === "SSE_REPLY_END") ended = true;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { frames, rest } = parseFrames(buffer);
			buffer = rest;
			for (const frame of frames) handle(frame);
			if (ended) break;
		}
	} finally {
		reader.releaseLock();
	}
	const text = stripPromptEcho(texts.join(""));
	if (!text) throw new DoubaoUpstreamError(`Doubao returned an empty completion${lastEventId ? ` (last event id ${lastEventId})` : ""}.`);
	return {
		text,
		...model !== void 0 ? { model } : {},
		...conversationId !== void 0 ? { conversationId } : {},
		...messageId !== void 0 ? { messageId } : {},
		thinking
	};
}
/**
* Remove the echoed user prompt from the front of the assembled text.
*
* Doubao's first chunk replays the inbound message; keeping it would make every
* reply appear to start with the user's own words.
*/
function stripPromptEcho(raw) {
	return raw.trimStart();
}
/**
* Collect a complete reply. Convenience wrapper over `streamChat` for callers
* that do not need incremental deltas.
*/
async function chat(prompt, options = {}) {
	return streamChat(prompt, options);
}
/** The server's business code for "this session is not valid". */
const CODE_SESSION_DEAD = 710012001;
/** The server's business code for a risk-control slider challenge. */
const CODE_RATE_LIMITED = 710022004;
/** Map one upstream error onto its class. */
function classifyDoubaoFailure(error) {
	if (error.rateLimited || error.code === CODE_RATE_LIMITED) return "rate_limited";
	if (error.code === CODE_SESSION_DEAD) return "session_dead";
	return "network";
}
/**
* User-facing text per class.
*
* The slider wording matters: it is the one failure the user can actually fix,
* and the only place they can fix it is the Doubao desktop client — retrying
* from the Harness will never clear it.
*/
const DOUBAO_ERROR_HINTS = {
	rate_limited: "豆包触发了风控验证（710022004）。请打开豆包客户端，手动发送一条消息完成滑块验证，然后再回到这里重试。反复重试只会让验证更严格。",
	quota_exhausted: "豆包额度已用尽。请等待额度窗口重置，或在豆包客户端查看「订阅与额度管理」。",
	session_dead: "豆包登录态失效。请在豆包客户端重新登录，然后重试。",
	network: "连接豆包失败（网络或超时）。请检查网络后重试。",
	upstream: "豆包上游返回了未知错误。"
};
/** Build a user-facing message for a Doubao failure. */
function describeDoubaoFailure(error) {
	if (error instanceof DoubaoUpstreamError) return `${DOUBAO_ERROR_HINTS[classifyDoubaoFailure(error)]}（${error.message}）`;
	return `${DOUBAO_ERROR_HINTS.network}${error?.message ?? ""}`;
}
/** Quick reachability probe that does not consume any inference quota. */
async function probeAccount(credentials) {
	if (!credentials.ok) return {
		ok: false,
		detail: credentials.reason ?? "no credentials"
	};
	const url = buildQueryUrl(ACCOUNT_ENDPOINT);
	const headers = buildHeaders(credentials);
	delete headers["content-type"];
	delete headers["last-event-id"];
	try {
		const response = await fetch(url, {
			method: "GET",
			headers
		});
		const payload = await response.json();
		if (!response.ok) return {
			ok: false,
			detail: `HTTP ${response.status}`
		};
		if (payload.data?.name) return {
			ok: true,
			detail: "signed in"
		};
		return {
			ok: false,
			detail: "session rejected by server"
		};
	} catch (error) {
		return {
			ok: false,
			detail: error.message
		};
	}
}
//#endregion
//#region src/doubao-quota.ts
/**
* Doubao quota.
*
* Doubao does NOT expose rate-limit headers on the chat endpoint — there is no
* `x-ratelimit-*` and no `x-event-states-limit`. The authoritative source is a
* separate summary endpoint that the desktop app calls on launch.
*
* It reports `window_limit_groups[].window_limits[]`, where each entry is one
* rolling consumption window:
*
*   window_type 1 -> 5-hour limit   (verified: end_time - start_time = 18e6 ms)
*   window_type 2 -> weekly quota    (verified: end_time - start_time = 604.8e6 ms)
*
* The window length was confirmed arithmetically from the server's own
* timestamps rather than inferred from the UI, so the mapping is pinned.
*/
/** Quota results are cached briefly so a chatty session does not hammer the API. */
const QUOTA_TTL_MS = 3e5;
function mapWindowType(value) {
	if (value === 1) return "five_hour";
	if (value === 2) return "weekly";
}
/**
* Nominal length of each rolling window, in ms.
*
* Verified arithmetically from the server's own timestamps in M2 (5-hour:
* end-start = 18e6; weekly: 604.8e6). Used ONLY to reconstruct a reset instant
* when the server reports a window with zeroed timestamps — see
* {@link normalizeWindow}.
*/
const WINDOW_MS = {
	five_hour: 18e6,
	weekly: 6048e5
};
/**
* Convert one server window into the shape the UI consumes.
*
* A window can come back with `start_time` and `end_time` both zero — observed
* on a freshly-reset 5-hour window. Passing that through verbatim would render
* a reset countdown of `0`, i.e. "resets right now", which is worse than
* useless: the user would read the window as expired while it is actually
* brand new and fully available. The window LENGTH is still known (it is fixed
* per window type), so a zeroed window is reconstructed as "opened now, resets
* one period from now", which is what the server means.
*/
function normalizeWindow(raw, now = Date.now()) {
	const type = raw.window_type === void 0 ? void 0 : mapWindowType(raw.window_type);
	if (!type) return void 0;
	const start = raw.start_time ?? 0;
	const end = raw.end_time ?? 0;
	const used = raw.used_percent ?? 0;
	const degraded = start <= 0 || end <= 0;
	const effectiveStart = degraded ? now : start;
	const effectiveEnd = degraded ? now + WINDOW_MS[type] : end;
	return {
		type,
		windowType: raw.window_type,
		usedPercent: used,
		remainingPercent: Math.max(0, 100 - used),
		resetsAt: effectiveEnd,
		startedAt: effectiveStart,
		windowMs: effectiveEnd > effectiveStart ? effectiveEnd - effectiveStart : 0,
		/** True when the reset instant was reconstructed rather than reported. */
		estimatedReset: degraded
	};
}
/**
* Read the account's current quota.
*
* Never throws: an unreachable endpoint yields a `DoubaoQuota` carrying an
* `error`, because a quota panel failure must not take down a chat request.
*/
async function fetchQuota(options = {}) {
	const now = Date.now();
	if (!options.force && cached && now - cached.fetchedAt < 3e5) return cached;
	const credentials = loadDoubaoCredentials();
	if (!credentials.ok) return {
		exhausted: false,
		windows: [],
		fetchedAt: now,
		error: credentials.reason ?? "Doubao credentials unavailable."
	};
	try {
		const response = await fetch(buildQueryUrl(QUOTA_ENDPOINT, credentials.pairs.get("msToken")), {
			method: "POST",
			headers: buildHeaders(credentials, { "content-type": "application/json" }),
			body: JSON.stringify({ product_line: "membership" })
		});
		if (!response.ok) return {
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: `HTTP ${response.status}`
		};
		const payload = await response.json();
		const groups = payload.data?.window_limit_section?.window_limit_groups ?? [];
		const windows = [];
		for (const group of groups) for (const limit of group.window_limits ?? []) {
			const normalized = normalizeWindow(limit);
			if (normalized) windows.push(normalized);
		}
		const quota = {
			exhausted: payload.data?.window_limit_section?.usage_exhausted === true || payload.data?.enterprise_window_limit_section?.usage_exhausted === true,
			windows,
			fetchedAt: now
		};
		const plan = payload.data?.current_subscription?.display?.short_name;
		if (plan) quota.plan = plan;
		if (payload.data?.member_info?.hasActiveSubscription !== void 0) quota.planActive = payload.data.member_info.hasActiveSubscription;
		cached = quota;
		return quota;
	} catch (error) {
		return {
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: error.message
		};
	}
}
let cached;
/** Drop the cached reading so the next call hits the server. */
function invalidateQuotaCache() {
	cached = void 0;
}
/** Convenience lookup for a specific window. */
function findWindow(quota, type) {
	return quota.windows.find((window) => window.type === type);
}
/**
* Milliseconds until a window resets, clamped at zero.
* Drives the countdown the user asked for.
*/
function millisUntilReset(window, now = Date.now()) {
	return Math.max(0, window.resetsAt - now);
}
/** Human-readable duration, e.g. `4h 12m`. */
function formatDuration(ms) {
	const total = Math.floor(ms / 1e3);
	const days = Math.floor(total / 86400);
	const hours = Math.floor(total % 86400 / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	const parts = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (!days && !hours && seconds) parts.push(`${seconds}s`);
	return parts.join(" ") || "0s";
}
//#endregion
export { REQUIRED_COOKIE_NAMES as A, DOUBAO_DEFAULT_MODEL_ID as B, describeDoubaoFailure as C, probeAccount as D, parseFrames as E, invalidateCredentialCache as F, DOUBAO_REASONING_LEVELS as G, DOUBAO_MODELS as H, loadDoubaoCredentials as I, enabledModelsOf as J, discoverDoubaoModels as K, CHAT_AGENT_MODE as L, decryptCookieValue as M, describeProfileLocation as N, streamChat as O, findDoubaoUserDataDir as P, DEFAULT_REASONING_LEVEL_ID as R, classifyDoubaoFailure as S, invalidateRenewals as T, DOUBAO_PROVIDER as U, DOUBAO_MAX_TOKENS as V, DOUBAO_PROVIDER_DISPLAY_NAME as W, findReasoningLevel as X, findDoubaoModel as Y, needDeepThinkOf as Z, applyRenewals as _, invalidateQuotaCache as a, buildQueryUrl as b, ACCOUNT_ENDPOINT as c, DEFAULT_BOT_ID as d, DOUBAO_ERROR_HINTS as f, RUNTIME_VERSION as g, QUOTA_ENDPOINT as h, formatDuration as i, decodeCookiePlaintext as j, CREDENTIAL_TTL_MS as k, CHAT_ENDPOINT as l, DoubaoUpstreamError as m, fetchQuota as n, millisUntilReset as o, DOUBAO_VERSION as p, doubaoCatalogEntries as q, findWindow as r, normalizeWindow as s, QUOTA_TTL_MS as t, CLIENT_PARAMS as u, buildChatBody as v, extractModel as w, chat as x, buildHeaders as y, DOUBAO_CONTEXT_WINDOW as z };
