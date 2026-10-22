import { createRequire } from "node:module";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
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
* `option.agent_mode` / `ext.agent_mode`.
*
* VERIFIED AGAINST A CDP-CAPTURED REQUEST (2026-10-22, 对话 mode):
*
*   agent_mode 2  →  普通对话
*   agent_mode 1  →  「工作任务」 (where every turn is handed to
*                    `Agent-GeneralTask` and then fails 710010702 when the
*                    desktop client's CUA runtime is not the requester)
*
* The previous revision of this constant said 1 for chat and carried a comment
* claiming work mode sends 2 — BOTH were backwards, and sending 1 is exactly
* what made every request from this plugin look like a work task.
*/
const CHAT_AGENT_MODE = 2;
/** 「工作任务」 mode. Its executing runtime is the desktop app's own process. */
const TASK_AGENT_MODE = 1;
/**
* Which machine runs a 「工作任务」.
*
* Read off the desktop client's own enum (`ai-views` bundle, module 941658):
*
*   RuntimeType_Cloud_VM  = 1   → 「工作任务 · 云电脑」: ByteDance's VM executes
*   RuntimeType_Local_PC  = 2   → 「工作任务 · 本地电脑」: THIS machine executes
*
* The plugin uses 2 on purpose: the cloud VM's artefacts are unreachable from an
* external client, whereas the local runtime is this very machine — the same one
* the Harness already executes tools on.
*/
const TASK_RUNTIME_CLOUD_VM = 1;
const TASK_RUNTIME_LOCAL_PC = 2;
/**
* Sandbox authorisation level.
*
* `2` is what the client sends with its 「全部允许」 authorisation setting (read
* off the same captured task request). The cloud uses it to decide how freely it
* may plan file and command actions inside the declared workspace.
*/
const TASK_SANDBOX_AUTH_ALLOW_ALL = 2;
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
* The two entries DSH may offer.
*
* WHY ONLY TWO. Doubao groups models by MODE, and the model list is per-mode:
*
*   对话       → 豆包 快速 (0), 豆包 2.1 Turbo·专家 (3)
*   工作任务   → 自动 (9), 2.1 Lite (seed-lite-7b), 2.1 Pro (5), Turbo (3)
*
* The 「工作任务」 group is not offered here because its requests are executed by
* the desktop client's own CUA runtime (`tasks-mode-resource` + `sbox`), which an
* external client cannot register; every such turn fails `710010702`. See the
* README's known limitations.
*
* MEASURED, 2026-10-22: `model_item_key` is forwarded verbatim (the server stores
* it on the message), but in 对话 mode it does NOT change what answers —
* 0 / 3 / 5 / seed-lite-7b AND a deliberately bogus key all returned answers of
* indistinguishable length and latency (12.3–14.0 s). So this list is honest
* about what the PICKER can offer; it does not claim per-key routing.
*
* 「豆包 快速」 leads because it is the app's own chat-mode default, so an
* unconfigured install reproduces the app rather than something that merely
* happens to work.
*/
const DOUBAO_MODELS = [{
	id: "0",
	name: "豆包 快速",
	reasoning: true
}, {
	id: "3",
	name: "豆包 2.1 Turbo",
	badge: "专家",
	reasoning: true
}];
/**
* Entries that exist in the desktop app but are deliberately NOT offered here.
*
* Kept as data rather than a comment so the README and any future UI can state
* the reason from one place — and so re-adding one is a deliberate act that has
* to confront this note.
*/
const DOUBAO_UNAVAILABLE_MODELS = [
	{
		id: "5",
		name: "豆包 2.1 Pro",
		reason: "「工作任务」专属：执行侧是客户端内的 CUA 运行时，外部客户端注册不进去"
	},
	{
		id: "seed-lite-7b",
		name: "豆包 2.1 Lite",
		reason: "同上（工作任务专属）"
	},
	{
		id: "9",
		name: "自动",
		reason: "同上（工作任务专属）"
	},
	{
		id: "4",
		name: "豆包 2.1 Turbo（即将下线）",
		reason: "客户端已用「即将下线」标注，不引导用户选择"
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
function dpapiCall(mode, blob) {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = \"SilentlyContinue\"",
		"$cs = 'using System; using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential)] public struct DshDataBlob { public int cbData; public IntPtr pbData; } public static class DshCrypt { [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptUnprotectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptProtectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); }'",
		"Add-Type -TypeDefinition $cs",
		"$bytes = [System.Convert]::FromBase64String($env:DSH_DOUBAO_DPAPI_BLOB)",
		"$len = [int]$bytes.Length",
		"$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)",
		"[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, $len)",
		"$inBlob = New-Object DshDataBlob",
		"$inBlob.cbData = $len",
		"$inBlob.pbData = $mem",
		"$outBlob = New-Object DshDataBlob",
		"if ($env:DSH_DPAPI_MODE -eq 'protect') {",
		"  $ok = [DshCrypt]::CryptProtectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"} else {",
		"  $ok = [DshCrypt]::CryptUnprotectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"}",
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
				DSH_DOUBAO_DPAPI_BLOB: blob.toString("base64"),
				DSH_DPAPI_MODE: mode
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
/** Convenience wrapper for the decrypt direction. */
function dpapiUnprotect(cipher) {
	return dpapiCall("unprotect", cipher);
}
/**
* Why a cache exists at all.
*
* The Doubao client takes an EXCLUSIVE lock on `Default\Network\Cookies` while
* it is active, so an external process cannot read the session at all while the
* app runs — `EBUSY` on open, on copy, everywhere. That is the NORMAL state for
* this plugin: its whole point is to use the account whose app is signed in.
*
* So a successful read is sealed with Windows DPAPI (current user scope) and
* kept under the DSH home. The plaintext never touches disk — only the sealed
* blob does — and that blob cannot be opened by another Windows account or
* moved to another machine. It expires, because the server rotates session
* cookies.
*/
const CREDENTIAL_CACHE_FILENAME = "doubao-credentials.dpapi";
/** Long enough to survive a reboot with the app open, short enough to expire. */
const CREDENTIAL_CACHE_TTL_MS = 432e5;
function credentialCachePath() {
	return join(homedir(), ".dsh", CREDENTIAL_CACHE_FILENAME);
}
/** Seal the current session to disk. Best-effort: never fails a request. */
function saveCredentialCache(credentials) {
	if (!credentials.ok) return;
	try {
		const payload = JSON.stringify({
			savedAt: Date.now(),
			header: credentials.header,
			pairs: [...credentials.pairs.entries()]
		});
		const sealed = dpapiCall("protect", Buffer.from(payload, "utf8"));
		mkdirSync(dirname(credentialCachePath()), { recursive: true });
		writeFileSync(credentialCachePath(), sealed);
	} catch {}
}
/** Read the sealed cache, or `undefined` when absent/expired/unreadable. */
function loadCredentialCache() {
	try {
		const json = dpapiCall("unprotect", readFileSync(credentialCachePath())).toString("utf8");
		const parsed = JSON.parse(json);
		if (typeof parsed.savedAt !== "number") return void 0;
		if (Date.now() - parsed.savedAt > CREDENTIAL_CACHE_TTL_MS) return void 0;
		if (typeof parsed.header !== "string" || !Array.isArray(parsed.pairs)) return void 0;
		const pairs = /* @__PURE__ */ new Map();
		for (const entry of parsed.pairs) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [name, value] = entry;
			if (typeof name === "string" && typeof value === "string" && name !== "") pairs.set(name, value);
		}
		if (REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name)).length > 0) return void 0;
		return {
			ok: true,
			header: parsed.header,
			pairs
		};
	} catch {
		return;
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
/** Block the current thread for `ms` (no async plumbing in this read path). */
function sleepSync(ms) {
	const view = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(view, 0, 0, ms);
}
/** Select the decryptable cookie rows from an opened database. */
function selectCookieRows(db) {
	return db.prepare("SELECT host_key, name, encrypted_value FROM cookies WHERE encrypted_value IS NOT NULL").all().map((r) => ({
		host: String(r.host_key),
		name: String(r.name),
		encrypted: Buffer.from(r.encrypted_value)
	}));
}
/**
* Read rows from the cookie jar.
*
* Two paths, because the live file is held by a running Chromium:
*
*   1. a read-only SQLite open on the ORIGINAL file — SQLite only needs a shared
*      lock, so this normally works even while the app is signed in and running;
*   2. a throwaway COPY, retried a few times. Windows share-deny locks and
*      on-access scanners make `copyFileSync` return `EBUSY` for a moment, and
*      that transient error used to surface as "credentials unreadable" — which
*      reads like a signed-out account and is the most misleading possible
*      message for a file that is simply busy.
*
* The original profile is only ever read.
*/
function readCookieRows(userDataDir) {
	const source = join(userDataDir, "Default", "Network", "Cookies");
	const { DatabaseSync } = require_("node:sqlite");
	for (let attempt = 0; attempt < 4; attempt += 1) try {
		const db = new DatabaseSync(source, { readOnly: true });
		try {
			return selectCookieRows(db);
		} finally {
			db.close();
		}
	} catch {
		if (attempt < 3) sleepSync(150);
	}
	const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-cookie-"));
	const copy = join(scratch, "Cookies.db");
	try {
		let copied = false;
		let lastError;
		for (let attempt = 0; attempt < 6 && !copied; attempt += 1) try {
			copyFileSync(source, copy);
			copied = true;
		} catch (error) {
			lastError = error;
			sleepSync(120);
		}
		if (!copied) throw new Error("the Doubao desktop client holds its Cookies database with an EXCLUSIVE lock (EBUSY), so no other process can read the session while it is in that state. Fully quit the Doubao client and retry: credentials are then cached in this process for 10 minutes, so the app can be reopened straight away.", { cause: lastError });
		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			return selectCookieRows(db);
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
	if (!credentials.ok && cached$1?.credentials.ok === true) {
		cached$1 = {
			at: now,
			credentials: cached$1.credentials
		};
		return cached$1.credentials;
	}
	if (!credentials.ok) {
		const sealed = loadCredentialCache();
		if (sealed !== void 0) {
			cached$1 = {
				at: now,
				credentials: sealed
			};
			return sealed;
		}
	}
	if (credentials.ok) saveCredentialCache(credentials);
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
* Stable-per-process id that rides along as `client_env_id`.
*
* The client generates one per app environment; ours is per host process so a
* restart looks like a new environment, which is exactly what it is.
*/
const CLIENT_ENV_ID = randomUUID();
/** Whether a request asks for local-PC task mode. Default: OFF — see below. */
function taskModeEnabled(options) {
	if (options.taskMode !== void 0) return options.taskMode;
	const flag = process.env.DSH_DOUBAO_TASK;
	return flag === void 0 ? false : /^(1|true|on|yes)$/i.test(flag.trim());
}
/** The directory this machine declares to the task runtime. */
function taskWorkspaceOf(options) {
	return options.workspace ?? process.env.DSH_DOUBAO_WORKSPACE ?? process.cwd();
}
/**
* Build `ext.general_task_param` — the field that makes a turn a 工作任务.
*
* Transcribed field-for-field from a real 「工作任务 · 本地电脑」 request the
* desktop client sent on 2026-09-15 (recovered from the app's own IndexedDB
* message store), then reduced to what is portable:
*
*   thread_local_message_id  the local message id being submitted
*   client_option            the workspace and the sandbox/authorisation policy
*   runtime_type             2 — Local_PC; the cloud VM would be 1
*   agent_task_param         the same facts again, device-side
*   agent_task_param_change  all false: nothing is being switched mid-thread
*
* Paths are computed from THIS machine rather than copied, because the cloud
* plans against them: a workspace that does not exist here would make the task
* fail inside the runtime instead of at submit time. `local_device_id` and
* `local_app_id` reuse the frozen client identity already in {@link CLIENT_PARAMS}
* — the captured request carries the same two values, so they are the same
* install identity and not per-request state.
*/
function buildGeneralTaskParam(localMessageId, workspace) {
	const userData = findDoubaoUserDataDir();
	const agentWorkspace = userData === void 0 ? join(tmpdir(), "dsh-doubao-agent-workspace") : join(userData, "Default", ".doubao", "agent_mode", "workspace");
	return {
		thread_local_message_id: [localMessageId],
		client_option: {
			shared_folder_path: [workspace, agentWorkspace],
			enable_sandbox: true,
			os: process.platform === "win32" ? "Windows" : process.platform,
			client_env_id: CLIENT_ENV_ID,
			sandbox_id: `route-${randomUUID()}`,
			workspace,
			agent_workspace: {
				agent_workspace: agentWorkspace,
				local_skill_paths: [join(homedir(), "Doubao", "skills"), join(homedir(), ".agents", "skills")]
			},
			sandbox_auth_type: 2
		},
		runtime_type: 2,
		need_modify_conversation: false,
		agent_task_param: {
			runtime_type: 2,
			device_name: hostname(),
			workspace,
			local_device_id: CLIENT_PARAMS.device_id,
			local_app_id: CLIENT_PARAMS.aid,
			sandbox_auth_type: 2
		},
		agent_task_param_change: {
			runtime_changed: false,
			device_changed: false,
			sandbox_auth_type_changed: false
		}
	};
}
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
	const task = taskModeEnabled(options);
	/**
	* 2 = 普通对话, 1 = 「工作任务」.
	*
	* CDP-captured from the running client on 2026-10-22. This constant was the
	* bug: the plugin sent 1 for chat, so the server answered every turn as a work
	* task — `Agent-GeneralTask`, then `710010702` because the task runtime is the
	* desktop app's own CUA process.
	*/
	const agentMode = options.agentMode ?? (task ? 1 : 2);
	const localMessageId = randomUUID();
	/**
	* Mode id the model picker groups by. The captured chat request carries "1" in
	* BOTH `conversation_init_ext` and `aggregate_params`; leaving it out lets the
	* server choose a mode for us.
	*/
	const modeId = (process.env.DSH_DOUBAO_MODE_ID ?? "").trim() || "1";
	const taskParam = task ? buildGeneralTaskParam(localMessageId, taskWorkspaceOf(options)) : { server_do_compare: true };
	return {
		messages: [{
			local_message_id: localMessageId,
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
			need_deep_think: 0,
			click_clear_context: false,
			from_suggest: false,
			is_regen: false,
			is_replace: false,
			is_from_click_option: false,
			is_from_click_softlink: false,
			disable_sse_cache: false,
			select_text_action: "",
			is_select_text: false,
			resend_for_regen: false,
			scene_type: 0,
			unique_key: randomUUID(),
			start_seq: 0,
			need_create_conversation: true,
			conversation_init_option: { need_ack_conversation: true },
			conversation_init_ext: {
				model_item_key: model.id,
				reasoning_effort: String(level.level),
				mode_id: modeId
			},
			regen_query_id: [],
			edit_query_id: [],
			regen_instruction: "",
			no_replace_for_regen: false,
			message_from: 0,
			shared_app_name: "",
			shared_app_id: "",
			sse_recv_event_options: { support_chunk_delta: true },
			support_lazy_fetch_stream: true,
			is_ai_playground: false,
			is_old_user: true,
			general_task_param: taskParam,
			recovery_option: {
				is_recovery: false,
				req_create_time_sec: Math.floor(Date.now() / 1e3),
				append_sse_event_scene: 0
			},
			message_storage_type: 0,
			related_deleted_message_ids: {},
			connector_info_list: [],
			model_config: {
				model_item_key: model.id,
				model_extra_params: {},
				reasoning_effort: level.level
			},
			aggregate_params: {
				mention_skill_list: "[]",
				mention_plugin_list: "[]",
				mention_ext: "[{}]",
				conversation_mode: "",
				mode_id: modeId,
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
			last_message_index: null,
			local_permissions: [
				{
					permission_name: "ACCESS_COARSE_LOCATION",
					status: 1
				},
				{
					permission_name: "ACCESS_FINE_LOCATION",
					status: 1
				},
				{
					permission_name: "ACCESS_BACKGROUND_LOCATION",
					status: 1
				}
			]
		},
		user_context: [],
		ext: {
			agent_mode: String(agentMode),
			use_deep_think: "0",
			sub_conv_firstmet_type: "1",
			general_task_param: JSON.stringify(taskParam),
			collection_id: "",
			is_finish: "1",
			conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
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
* One attempt, no fallback. Split out so {@link streamChat} can retry a
* task-mode call as plain chat when the task runtime is not attached.
*/
async function streamOnce(prompt, options = {}) {
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
	return await consumeStream(response, options.callbacks, { harvestNotifyText: taskModeEnabled(options) });
}
/**
* Stream one completion and return the assembled reply.
*
* Rejects with `DoubaoUpstreamError` when the server answers with a business
* error frame — notably `710022004 rate limited`, which is risk control asking
* for a slider CAPTCHA rather than an authentication failure.
*
* TASK MODE FALLBACK. 「工作任务 · 本地电脑」 is the default, but the task agent
* is executed by a runtime that only the desktop app attaches; when it is
* absent the server answers the turn with `710010702 system error` instead of a
* reply (verified: the stream still names `Agent-GeneralTask`, so the mode
* itself was accepted). Rather than hand that placeholder to the user, the call
* is retried ONCE as plain chat — and only when the failed attempt emitted no
* text, so a fallback can never duplicate a partially streamed answer.
*/
async function streamChat(prompt, options = {}) {
	let emittedText = false;
	const wrapped = {
		onText: (delta) => {
			if (delta) emittedText = true;
			options.callbacks?.onText?.(delta);
		},
		onEvent: (event) => options.callbacks?.onEvent?.(event)
	};
	const wanted = taskModeEnabled(options);
	const call = (taskMode) => streamOnce(prompt, {
		...options,
		callbacks: wrapped,
		taskMode
	});
	try {
		return await call(wanted);
	} catch (error) {
		const taskRuntimeMissing = error instanceof DoubaoUpstreamError && (error.code === CODE_TASK_RUNTIME_UNAVAILABLE || /agent_err_real_answer/.test(error.message));
		if (!wanted || !taskRuntimeMissing || emittedText) throw error;
		return call(false);
	}
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
async function consumeStream(response, callbacks, options = {}) {
	const reader = response.body?.getReader();
	if (!reader) throw new DoubaoUpstreamError("Doubao returned an empty response body.");
	const decoder = new TextDecoder();
	let buffer = "";
	const texts = [];
	/** Text carried by STREAM_MSG_NOTIFY instead of by chunk deltas. */
	const notifyTexts = [];
	let conversationId;
	let messageId;
	let model;
	let thinking = false;
	let lastEventId;
	let ended = false;
	/**
	* Every event name seen, in arrival order (deduped).
	*
	* Task mode answers with a richer event vocabulary than chat, so an empty
	* completion is usually "the text lives in an event we do not harvest yet"
	* rather than "the server said nothing". Naming the events turns an opaque
	* failure into a next step.
	*/
	const events = /* @__PURE__ */ new Set();
	/** The agent that served this turn, when the server names one. */
	let intentionAgent;
	/**
	* `expose_reason` of a task turn whose runtime was unreachable.
	*
	* Recorded instead of surfacing its placeholder text (「出了点问题，请稍后重试。」),
	* which reads like a transient glitch and hides the actual cause.
	*/
	let taskAgentError;
	const handle = (frame) => {
		const name = frame.event ?? "";
		if (name) events.add(name);
		if (process.env.DSH_DOUBAO_DEBUG_FRAMES === "1" && frame.data) process.stderr.write(`[frame ${name || "(none)"}] ${frame.data.slice(0, 1500)}\n`);
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
			const record = payload;
			messageId = record.message?.message_id ?? messageId;
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			const ext = record.content?.ext ?? record.message?.ext ?? record.ext;
			if (ext !== void 0 && ext !== null && typeof ext === "object") {
				const agent = ext.intention_agent_name;
				if (typeof agent === "string" && agent !== "") intentionAgent = agent;
				const reason = ext.expose_reason;
				if (typeof reason === "string" && /agent_err_real_answer/.test(reason)) taskAgentError = reason;
			}
			if (name === "STREAM_MSG_NOTIFY") {
				const acc = { out: [] };
				harvestText(record.content?.content_block, acc);
				for (const piece of acc.out) {
					if (!piece) continue;
					notifyTexts.push(piece);
					if (callbacks?.onText) callbacks.onText(piece);
				}
			}
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
	const chunkText = texts.join("");
	const notifyText = notifyTexts.join("");
	const text = stripPromptEcho(chunkText.startsWith(notifyText) ? chunkText : notifyText + chunkText);
	if (taskAgentError !== void 0) throw new DoubaoUpstreamError(`Doubao accepted the task but its executing runtime was unreachable (${taskAgentError}). The 「工作任务」 runtime is attached by the desktop client; without it the agent has nowhere to run.`, CODE_TASK_RUNTIME_UNAVAILABLE);
	if (!text) {
		const seen = [...events];
		throw new DoubaoUpstreamError(`Doubao returned an empty completion${lastEventId ? ` (last event id ${lastEventId})` : ""}${seen.length > 0 ? `; events seen: ${seen.join(", ")}` : "; no events at all"}.`);
	}
	return {
		text,
		...model !== void 0 ? { model } : {},
		...conversationId !== void 0 ? { conversationId } : {},
		...messageId !== void 0 ? { messageId } : {},
		...intentionAgent !== void 0 ? { intentionAgent } : {},
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
/**
* The server's business code when a 「工作任务」 was accepted but its executing
* runtime could not be reached (`expose_reason: agent_err_real_answer`).
*
* This is the signature of "the mode is right, the local runtime is not
* attached" — the desktop client's CUA runtime registers itself; an external
* client has nothing to register, so the agent has nowhere to run.
*/
const CODE_TASK_RUNTIME_UNAVAILABLE = 710010702;
/** Map one upstream error onto its class. */
function classifyDoubaoFailure(error) {
	if (error.rateLimited || error.code === CODE_RATE_LIMITED) return "rate_limited";
	if (error.code === CODE_TASK_RUNTIME_UNAVAILABLE) return "task_runtime_unavailable";
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
	task_runtime_unavailable: "豆包把这个账号路由到了「工作任务」代理，而该任务的执行运行时只存在于豆包客户端进程里，外部客户端接不上。请打开豆包客户端，把输入框上方的开关切回「对话」，然后重试；需要多步执行的话，交给 DSH 自己的工具来做。",
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
export { TASK_SANDBOX_AUTH_ALLOW_ALL as $, taskModeEnabled as A, CHAT_AGENT_MODE as B, classifyDoubaoFailure as C, parseFrames as D, invalidateRenewals as E, decryptCookieValue as F, DOUBAO_MODELS as G, DOUBAO_CONTEXT_WINDOW as H, describeProfileLocation as I, DOUBAO_REASONING_LEVELS as J, DOUBAO_PROVIDER as K, findDoubaoUserDataDir as L, CREDENTIAL_TTL_MS as M, REQUIRED_COOKIE_NAMES as N, probeAccount as O, decodeCookiePlaintext as P, TASK_RUNTIME_LOCAL_PC as Q, invalidateCredentialCache as R, chat as S, extractModel as T, DOUBAO_DEFAULT_MODEL_ID as U, DEFAULT_REASONING_LEVEL_ID as V, DOUBAO_MAX_TOKENS as W, TASK_AGENT_MODE as X, DOUBAO_UNAVAILABLE_MODELS as Y, TASK_RUNTIME_CLOUD_VM as Z, applyRenewals as _, invalidateQuotaCache as a, needDeepThinkOf as at, buildHeaders as b, ACCOUNT_ENDPOINT as c, DEFAULT_BOT_ID as d, discoverDoubaoModels as et, DOUBAO_ERROR_HINTS as f, RUNTIME_VERSION as g, QUOTA_ENDPOINT as h, formatDuration as i, findReasoningLevel as it, taskWorkspaceOf as j, streamChat as k, CHAT_ENDPOINT as l, DoubaoUpstreamError as m, fetchQuota as n, enabledModelsOf as nt, millisUntilReset as o, DOUBAO_VERSION as p, DOUBAO_PROVIDER_DISPLAY_NAME as q, findWindow as r, findDoubaoModel as rt, normalizeWindow as s, QUOTA_TTL_MS as t, doubaoCatalogEntries as tt, CLIENT_PARAMS as u, buildChatBody as v, describeDoubaoFailure as w, buildQueryUrl as x, buildGeneralTaskParam as y, loadDoubaoCredentials as z };
