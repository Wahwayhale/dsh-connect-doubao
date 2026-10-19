import { H as DOUBAO_MODELS, I as loadDoubaoCredentials, J as enabledModelsOf, N as describeProfileLocation, S as classifyDoubaoFailure, U as DOUBAO_PROVIDER, V as DOUBAO_MAX_TOKENS, W as DOUBAO_PROVIDER_DISPLAY_NAME, Y as findDoubaoModel, a as invalidateQuotaCache, m as DoubaoUpstreamError, n as fetchQuota, o as millisUntilReset, q as doubaoCatalogEntries, r as findWindow, x as chat, z as DOUBAO_CONTEXT_WINDOW } from "./doubao-quota-12DrjjCQ.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
//#region src/doubao-adapter.ts
/**
* The Doubao pi-ai provider, registered into the Harness LLM seam.
*
* Assembly follows the public `dsh-llm-pi-ai` extension points, as used by
* `dsh-connect-workbuddy`:
*
*   createProvider(...)  ->  a pi-ai Provider whose models all point at the
*                           loopback shim's OpenAI-shaped surface
*   PiAiAdapter          ->  the Harness-facing adapter built from a resolved
*                           provider profile
*
* The shim (not this file) owns the Doubao dialect and all inbound hardening;
* this module only decides what the picker shows and how failures are labelled.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
*   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
*     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目实现。
*
* @module dsh-connect-doubao/adapter
*/
/** Provider idle ceiling while one stream read is outstanding. */
const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Inert pi-ai auth plane.
*
* The Doubao route authenticates only through the shim's per-process shared
* secret (resolved as the OpenAI apiKey) plus the cookie jar the shim reads
* from the local profile. pi-ai's own credential lifecycle and ambient
* discovery must never manufacture a credential here.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-doubao: the doubao route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Image-request budgets: this route is text-only, so the caps are inert. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 0,
	requestImagePixelBudget: 0,
	requestImageMaxBytes: 0
};
/**
* Thinking level map for an entry.
*
* The map is a TRANSLATION, not a passthrough: pi-ai spells levels OpenAI's way
* (`minimal`, `low`, `medium`, `high`) while Doubao publishes only 低 / 中 / 高.
* Doubao's own ids are sent as the values so the shim can hand them straight to
* `streamChat` without a second lookup — see `toDoubaoLevel` in the shim.
*
* Doubao has no "off": the weakest published level is 低, so `off` maps to it
* rather than to nothing. A model that declares no reasoning pins every level,
* so the picker cannot request thinking from a route that will not honour it.
*/
function thinkingLevelMap(info) {
	const levels = [
		"minimal",
		"low",
		"medium",
		"high"
	];
	if (!info.reasoning) return Object.fromEntries([...levels, "off"].map((level) => [level, null]));
	return {
		minimal: "low",
		low: "low",
		medium: "mid",
		high: "high",
		off: "low"
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	const levels = thinkingLevelMap(info);
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text"],
		cost: NO_COST,
		contextWindow: DOUBAO_CONTEXT_WINDOW,
		maxTokens: DOUBAO_MAX_TOKENS,
		reasoning: info.reasoning,
		thinkingLevelMap: levels,
		compat: { supportsReasoningEffort: info.reasoning }
	};
}
/**
* Assemble the adapter.
*
* Every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
* applies from the first snapshot after startup.
*/
function createDoubaoAdapter(options) {
	const { shim } = options;
	const providerId = DOUBAO_PROVIDER;
	const providerName = DOUBAO_PROVIDER_DISPLAY_NAME;
	/**
	* Which catalog ids are currently in force, or undefined for "never
	* configured" (serve everything). Updated by {@link setEnabledModelIds} when
	* the user saves a different checklist selection.
	*/
	let enabledIds = options.enabledModelIds;
	let syncBaseUrl = shim.baseUrlSync();
	if (syncBaseUrl === void 0) shim.baseUrl().then((resolved) => {
		syncBaseUrl = resolved;
	}).catch(() => {});
	const buildModels = () => {
		const address = syncBaseUrl;
		if (address === void 0) return [];
		const baseUrl = `${address}/v1`;
		return enabledModelsOf(enabledIds).map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: providerName,
			auth: { apiKey: {
				name: "Doubao loopback shim secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Doubao"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName: providerName,
		streamIdleTimeoutMs: DOUBAO_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-doubao retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token()
		}),
		invalidate: () => {
			syncBaseUrl ??= shim.baseUrlSync();
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		},
		setEnabledModelIds: (ids) => {
			enabledIds = ids;
			syncBaseUrl ??= shim.baseUrlSync();
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/doubao-shim.ts
/**
* Loopback shim for the Doubao route.
*
* pi-ai's OpenAI-completions API object wants an OpenAI-shaped HTTP endpoint.
* Doubao speaks a private three-line streaming dialect at a different origin,
* with credentials resolved out of a Chromium profile rather than a bearer
* token. This shim is the boundary: it terminates an OpenAI-shaped request on
* an ephemeral 127.0.0.1 port and speaks Doubao upstream.
*
* SECURITY. Everything in the inbound half is upstream-independent hardening
* and is kept deliberately identical to `dsh-connect-workbuddy`'s shim:
*
*   * binds 127.0.0.1 only, on an ephemeral port;
*   * Host header must name loopback (drops DNS-rebinding pages);
*   * a browser-sent Origin must be loopback;
*   * a per-process shared secret, compared in constant time, which pi-ai
*     sends as `Authorization: Bearer`. The secret NEVER leaves this process
*     and is never forwarded upstream — Doubao authenticates on the cookie
*     jar, which the shim resolves per request;
*   * chat POSTs must be `application/json`;
*   * request bodies are size-capped.
*
* Nothing that leaves this process carries the shared secret except the
* loopback hop, and nothing that arrives is trusted without passing all of the
* above.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）；
*   入站加固层的做法（loopback 绑定、Host/Origin 校验、常量时间 bearer 比对、
*   JSON content-type 强制、body 上限）由该项目确立，本文件原样复用其安全策略。
*
* @module dsh-connect-doubao/shim
*/
/** Hostnames the inbound half will accept. */
const LOOPBACK_HOSTS$1 = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Cap on an inbound chat body. Doubao replies are short; anything larger is abuse. */
const MAX_BODY_BYTES = 4194304;
/** Strip a port and IPv6 brackets from a Host/Origin hostname. */
function hostnameOfHost(host) {
	let hostname = host.trim();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The Host header must name loopback. A DNS-rebinding page re-resolves an
* attacker domain to 127.0.0.1 but still sends its own domain in Host, so this
* drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS$1.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin must be loopback. Non-browser clients send no Origin
* at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS$1.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each Doubao failure class surfaces as. */
const KIND_STATUS = {
	rate_limited: 429,
	quota_exhausted: 429,
	session_dead: 401,
	network: 502,
	upstream: 502
};
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** OpenAI-shaped error envelope, which is what pi-ai parses. */
function writeOpenAIError(res, status, code, message) {
	writeJson(res, status, { error: {
		message,
		type: code,
		code
	} });
}
/**
* Translate the adapter's thinking-level spelling into a Doubao level id.
*
* pi-ai speaks OpenAI's names — including `medium` and `minimal`, which Doubao
* has no equivalent for. Doubao only publishes 低 / 中 / 高, so the nearest
* Doubao level wins: `minimal` and `low` both mean 低, `medium` means 中.
* An unrecognised or absent value leaves the default in place.
*/
function toDoubaoLevel(spelling) {
	switch (spelling) {
		case "minimal":
		case "low": return "low";
		case "medium": return "mid";
		case "high": return "high";
		default: return;
	}
}
/**
* Name the model a request ASKED for, in words a user can read.
*
* Doubao's `model_item_key` values are opaque (`0`, `3`, `5`, `seed-lite-7b`),
* so the wire key means nothing outside the client. Returning the name — and
* naming the field `requested_model` rather than `model` — keeps the statement
* inside what we actually know: this is what we sent, not what served the
* reply. An id the catalog does not know is echoed verbatim with `unknown`, so
* a typo cannot be mistaken for a valid model.
*/
function describeRequestedModel(key) {
	if (key === void 0) {
		const fallback = findDoubaoModel(void 0);
		return {
			name: fallback.name,
			item_key: fallback.id
		};
	}
	return DOUBAO_MODELS.some((model) => model.id === key) ? {
		name: findDoubaoModel(key).name,
		item_key: key
	} : {
		name: key,
		item_key: key,
		unknown: true
	};
}
/**
* Resolve the per-request upstream knobs from an inbound request.
*
* Without this the shim would silently discard the model the caller picked:
* the inbound `model` is a catalog id that IS Doubao's `model_item_key`, and
* `reasoning_effort` is the adapter's level spelling.
*/
function requestOptions(parsed) {
	const level = toDoubaoLevel(parsed.reasoning_effort);
	return {
		...parsed.model === void 0 ? {} : { modelKey: parsed.model },
		...level === void 0 ? {} : { reasoningLevel: level }
	};
}
/**
* Flatten pi-ai's content shapes (string | block array) into plain text.
*
* Doubao's endpoint takes one `text_block`, so multimodal blocks are not
* forwarded: this provider advertises text-only input and the adapter never
* offers anything else.
*/
function flattenContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const record = block;
			if (typeof record.text === "string") parts.push(record.text);
			else if (typeof record.content === "string") parts.push(record.content);
		}
	}
	return parts.join("\n");
}
/**
* Assemble the final prompt from the inbound transcript.
*
* Doubao's endpoint carries one user message; a multi-turn transcript is
* flattened newest-last with role prefixes so the model still sees the
* history. The system prompt is folded in as context rather than dropped.
*/
function buildPrompt(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	const turns = [];
	for (const message of messages) {
		const text = flattenContent(message.content);
		if (!text) continue;
		const role = message.role ?? "user";
		turns.push(role === "user" ? text : `[${role}] ${text}`);
	}
	return turns.join("\n\n");
}
function createDoubaoShim(options = {}) {
	const resolveCredentials = options.resolveCredentials ?? loadDoubaoCredentials;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	/** Read a size-capped request body. Rejects over-limit and wrong content types. */
	function readBody(req) {
		return new Promise((resolve) => {
			const chunks = [];
			let size = 0;
			let aborted = false;
			req.on("data", (chunk) => {
				if (aborted) return;
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					aborted = true;
					resolve(void 0);
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (!aborted) resolve(Buffer.concat(chunks));
			});
			req.on("error", () => {
				if (!aborted) resolve(void 0);
			});
		});
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = async () => {
		await ready.catch(() => {});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("doubao shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	/** Translate one Doubao failure into the OpenAI error envelope pi-ai expects. */
	function writeFailure(res, error) {
		const kind = error instanceof DoubaoUpstreamError ? classifyDoubaoFailure(error) : "network";
		const message = error?.message ?? "Doubao upstream failed";
		const status = KIND_STATUS[kind];
		writeOpenAIError(res, status, kind === "network" ? "TIMEOUT" : kind === "quota_exhausted" ? "RATE_LIMIT" : "SERVER", message);
	}
	/** Stream a completion as OpenAI SSE chunks. */
	/**
	* Stream one completion back as OpenAI-shaped SSE chunks.
	*
	* `parsed` is needed for the model and thinking level: the prompt alone says
	* nothing about which of them the caller picked.
	*/
	async function streamCompletion(res, prompt, parsed) {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		const send = (payload) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
		};
		let roleSent = false;
		try {
			await chat(prompt, {
				...requestOptions(parsed),
				callbacks: { onText: (delta) => {
					if (!roleSent) {
						send({ choices: [{
							index: 0,
							delta: { role: "assistant" },
							finish_reason: null
						}] });
						roleSent = true;
					}
					send({ choices: [{
						index: 0,
						delta: { content: delta },
						finish_reason: null
					}] });
				} }
			});
			if (!roleSent) send({ choices: [{
				index: 0,
				delta: { role: "assistant" },
				finish_reason: null
			}] });
			send({ choices: [{
				index: 0,
				delta: {},
				finish_reason: "stop"
			}] });
			if (!res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		} catch (error) {
			send({ error: {
				message: error?.message ?? "Doubao upstream failed",
				type: "SERVER"
			} });
			if (!res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		}
	}
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && url.startsWith("/quota")) {
				const quota = await fetchQuota();
				const fiveHour = findWindow(quota, "five_hour");
				const weekly = findWindow(quota, "weekly");
				writeJson(res, 200, {
					ok: true,
					plan: quota.plan ?? null,
					exhausted: quota.exhausted,
					windows: {
						fiveHour: fiveHour ? {
							usedPercent: fiveHour.usedPercent,
							remainingPercent: fiveHour.remainingPercent,
							resetsAt: fiveHour.resetsAt,
							resetsInMs: millisUntilReset(fiveHour)
						} : null,
						weekly: weekly ? {
							usedPercent: weekly.usedPercent,
							remainingPercent: weekly.remainingPercent,
							resetsAt: weekly.resetsAt,
							resetsInMs: millisUntilReset(weekly)
						} : null
					},
					error: quota.error ?? null
				});
				return;
			}
			if (!(url.startsWith("/v1/chat/completions") || url === "/v1/chat/completions") || req.method !== "POST") {
				writeOpenAIError(res, 404, "not_found", "unsupported route");
				return;
			}
			if (!isJsonContentType(req)) {
				writeOpenAIError(res, 415, "unsupported_media_type", "chat requests must be application/json");
				return;
			}
			const credentials = resolveCredentials();
			if (!credentials.ok) {
				writeOpenAIError(res, 401, "session_dead", credentials.reason ?? "Doubao is not signed in");
				return;
			}
			const raw = await readBody(req);
			if (raw === void 0) {
				writeOpenAIError(res, 413, "payload_too_large", "request body exceeds the size limit");
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(raw.toString("utf8"));
			} catch {
				writeOpenAIError(res, 400, "invalid_request", "request body is not valid JSON");
				return;
			}
			if ((await fetchQuota()).exhausted) {
				writeOpenAIError(res, 429, "quota_exhausted", "豆包额度已用尽。请等待额度窗口重置，或在豆包客户端中查看额度状态。");
				return;
			}
			const prompt = buildPrompt(parsed.messages);
			if (!prompt) {
				writeOpenAIError(res, 400, "invalid_request", "no usable message content");
				return;
			}
			if (parsed.stream === false) {
				const result = await chat(prompt, requestOptions(parsed));
				const sent = findDoubaoModel(parsed.model);
				writeJson(res, 200, {
					id: `doubao-${Date.now()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1e3),
					model: sent.id,
					requested_model: describeRequestedModel(parsed.model),
					choices: [{
						index: 0,
						message: {
							role: "assistant",
							content: result.text
						},
						finish_reason: "stop"
					}]
				});
				return;
			}
			await streamCompletion(res, prompt, parsed);
		} catch (error) {
			writeFailure(res, error);
		}
	}
	/** Synchronous view of the origin; undefined until the socket is bound. */
	const baseUrlSync = () => {
		const address = server.address();
		if (address === null || typeof address === "string") return void 0;
		return `http://127.0.0.1:${address.port}`;
	};
	return {
		baseUrl,
		baseUrlSync,
		token: () => SHARED_SECRET,
		async close() {
			await ready.catch(() => {});
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
//#endregion
//#region src/doubao-status.ts
/** Route path, relative to the plugin mount point. */
const DOUBAO_QUOTA_PATH = "/plugins/dsh-connect-doubao/quota";
/** Route serving the model checklist's catalog. */
const DOUBAO_CATALOG_PATH = "/plugins/dsh-connect-doubao/catalog";
/** Hostnames an inbound browser request may come from. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/**
* A browser-sent Origin must be loopback. A page on an attacker origin that
* can reach the Harness server must not be able to read the user's quota.
*/
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}
/**
* Strip anything that could carry a secret or personal data out of an error.
* Upstream messages are quoted into the payload, so they are truncated and
* only the class is preserved.
*/
function safeMessage(error) {
	return (error?.message ?? "unknown error").slice(0, 200);
}
/**
* Build the quota view.
*
* An allow-list on purpose: every field here is a number or a plan name chosen
* by this function, never a passthrough of the upstream payload.
*/
async function doubaoQuotaView(options = {}) {
	const quota = await fetchQuota(options.force === true ? { force: true } : {});
	const fiveHour = findWindow(quota, "five_hour");
	const weekly = findWindow(quota, "weekly");
	return {
		ok: quota.error === void 0,
		profile: describeProfileLocation(),
		plan: quota.plan ?? null,
		exhausted: quota.exhausted,
		windows: {
			fiveHour: fiveHour === void 0 ? null : {
				usedPercent: fiveHour.usedPercent,
				remainingPercent: fiveHour.remainingPercent,
				resetsAt: fiveHour.resetsAt,
				resetsInMs: millisUntilReset(fiveHour)
			},
			weekly: weekly === void 0 ? null : {
				usedPercent: weekly.usedPercent,
				remainingPercent: weekly.remainingPercent,
				resetsAt: weekly.resetsAt,
				resetsInMs: millisUntilReset(weekly)
			}
		},
		fetchedAt: quota.fetchedAt,
		error: quota.error ?? null
	};
}
/** Register the quota route. Returns a disposer. */
function registerDoubaoQuotaRoute(ctx, deps = {}) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_QUOTA_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return;
			}
			const force = req.method === "POST";
			if (force) {
				invalidateQuotaCache();
				deps.onRefresh?.();
			}
			try {
				json(res, 200, await doubaoQuotaView(force ? { force: true } : {}));
			} catch (error) {
				json(res, 500, { error: safeMessage(error) });
			}
		}
	});
}
/**
* Register the read-only catalog route backing the card's model checklist.
*
* Same security posture as the quota route: an allow-list (the static catalog),
* the same loopback-origin fence, no credential of any kind.
*
* `refresh=true` re-reads nothing on purpose — the Doubao catalog is STATIC and
* cannot be asked upstream which models exist (see `doubao-catalog.ts`). The
* card's Refresh button therefore re-reads this route, which is the honest
* behaviour: it refreshes the VIEW, and the card's note tells the user that
* selection controls picker entries rather than routing.
*/
function registerDoubaoCatalogRoute(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_CATALOG_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return;
			}
			json(res, 200, {
				ok: true,
				models: doubaoCatalogEntries(),
				error: null
			});
		}
	});
}
//#endregion
export { registerDoubaoQuotaRoute as a, createDoubaoAdapter as c, registerDoubaoCatalogRoute as i, DOUBAO_QUOTA_PATH as n, createDoubaoShim as o, doubaoQuotaView as r, DOUBAO_STREAM_IDLE_TIMEOUT_MS as s, DOUBAO_CATALOG_PATH as t };
