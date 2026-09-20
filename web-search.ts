/**
 * 联网搜索（pi 扩展）—— Firecrawl 主通道 + Tavily 兜底
 *
 * 注册自定义工具 web_search：
 *   ① 主通道：POST https://api.firecrawl.dev/v2/search（Bearer fc- key，credits 计费）
 *      - 结果在 data.web[]，含 title / url / description
 *      - 失败后先重试（默认 3 次，指数退避）；认证/额度类错误（401/402/403）与分钟级限流 429 直接跳过重试
 *   ② 兜底：POST https://api.tavily.com/search（Bearer tvly- key，credits 计费）
 *      - 结果在 results[]，含 title / url / content
 *      - 免费额度 1000 credits/月（basic 深度 1 credit/次，advanced 2 credits/次）
 *
 * 密钥：
 *   - FIRECRAWL_API_KEY（fc- 开头）环境变量，未设置则跳过主通道
 *   - TAVILY_API_KEY 环境变量；也支持密钥文件 ~/.pi/tavily.key（便于不重启进程即生效）
 *
 * 可选环境变量：
 *   FIRECRAWL_SEARCH_HOST      默认 https://api.firecrawl.dev
 *   FIRECRAWL_RETRY_COUNT      主通道失败后的重试次数，默认 3（不含首次，共 4 次尝试）
 *   FIRECRAWL_RETRY_BASE_MS    重试退避基数，默认 500ms（指数：500 / 1000 / 2000）
 *   TAVILY_SEARCH_HOST         默认 https://api.tavily.com
 *   TAVILY_SEARCH_DEPTH        兜底搜索深度，默认 advanced（basic 消耗 1 credit/次，advanced 2 credits/次）
 *   TAVILY_SEARCH_TIMEOUT_MS   请求超时，默认 20000
 *
 * 加载位置：~/.pi/agent/extensions/（全局），/reload 可热重载。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const FC_HOST = process.env.FIRECRAWL_SEARCH_HOST ?? "https://api.firecrawl.dev";
const TV_HOST = process.env.TAVILY_SEARCH_HOST ?? "https://api.tavily.com";
const TV_DEPTH = process.env.TAVILY_SEARCH_DEPTH === "basic" ? "basic" : "advanced";
const TIMEOUT_MS = Number(process.env.TAVILY_SEARCH_TIMEOUT_MS ?? 20_000);
const FC_RETRY_COUNT = Number(process.env.FIRECRAWL_RETRY_COUNT ?? 3); // Firecrawl 失败后的重试次数（不含首次）
const FC_RETRY_BASE_MS = Number(process.env.FIRECRAWL_RETRY_BASE_MS ?? 500); // 指数退避基数

// ── 类型 ────────────────────────────────────────────────────────────

interface FcItem {
	title?: string;
	url?: string;
	description?: string;
}

interface FcResponse {
	success?: boolean;
	data?: { web?: FcItem[] };
	creditsUsed?: number;
	error?: string;
}

interface TvItem {
	title?: string;
	url?: string;
	content?: string;
	score?: number;
}

interface TvResponse {
	results?: TvItem[];
	detail?: { error?: string } | string;
}

// ── Firecrawl 主通道 ────────────────────────────────────────────────

/** Firecrawl 错误：带状态码与「是否值得重试」判定 */
class FcError extends Error {
	status?: number;
	retryable: boolean;
	attempts?: number;

	constructor(message: string, status: number | undefined, retryable: boolean) {
		super(message);
		this.name = "FcError";
		this.status = status;
		this.retryable = retryable;
	}
}

const RECENCY_TO_TBS: Record<string, string> = {
	oneDay: "qdr:d",
	oneWeek: "qdr:w",
	oneMonth: "qdr:m",
	oneYear: "qdr:y",
};

/** undici 网络层错误的 message 恒为 "fetch failed"，真实原因在 cause（如 ECONNRESET / ENOTFOUND） */
function netDetail(e: unknown): string {
	const cause = (e as { cause?: { code?: string; message?: string } } | undefined)?.cause;
	return cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
}

async function fcSearch(
	key: string,
	query: string,
	count: number,
	recency?: string,
	domain?: string,
): Promise<{ items: FcItem[]; credits: number }> {
	let q = query;
	if (domain) q += ` site:${domain}`;
	const body: Record<string, unknown> = { query: q, limit: count };
	if (recency && RECENCY_TO_TBS[recency]) body.tbs = RECENCY_TO_TBS[recency];

	let resp: Response;
	try {
		resp = await fetch(`${FC_HOST}/v2/search`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		throw new FcError(`fetch failed（${netDetail(e)}）`, undefined, true);
	}
	if (!resp.ok) {
		// 401/402/403 属认证或额度问题；429 是分钟级速率限制（实测免费版 10 req/min）
		// 两者重试都无法解决，直接交给调用方回退 Tavily
		const retryable = ![401, 402, 403, 429].includes(resp.status);
		throw new FcError(`HTTP ${resp.status}`, resp.status, retryable);
	}
	const data = (await resp.json()) as FcResponse;
	if (data.success === false || data.error) throw new FcError(data.error ?? "业务错误", undefined, true);
	return { items: data.data?.web ?? [], credits: data.creditsUsed ?? 0 };
}

/** 主通道 + 重试：失败后最多重试 FC_RETRY_COUNT 次（指数退避），仍失败才由调用方回退 Tavily */
async function fcSearchWithRetry(
	key: string,
	query: string,
	count: number,
	recency?: string,
	domain?: string,
): Promise<{ items: FcItem[]; credits: number; attempts: number }> {
	const maxAttempts = Math.max(1, FC_RETRY_COUNT + 1); // 首次 + N 次重试
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const r = await fcSearch(key, query, count, recency, domain);
			return { ...r, attempts: attempt };
		} catch (e) {
			lastErr = e;
			if (e && typeof e === "object") (e as { attempts?: number }).attempts = attempt; // 供上层记录实际尝试次数
			const retryable = e instanceof FcError ? e.retryable : true;
			if (!retryable || attempt === maxAttempts) break;
			const wait = FC_RETRY_BASE_MS * 2 ** (attempt - 1);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Tavily 兜底通道 ─────────────────────────────────────────────────

const RECENCY_TO_RANGE: Record<string, string> = {
	oneDay: "day",
	oneWeek: "week",
	oneMonth: "month",
	oneYear: "year",
};

/** 密钥来源：环境变量优先，其次 ~/.pi/tavily.key（文件方式无需重启进程即生效） */
function resolveTavilyKey(): string | null {
	const envKey = process.env.TAVILY_API_KEY?.trim();
	if (envKey) return envKey;
	const candidates = [
		path.join(os.homedir(), ".pi", "tavily.key"),
		path.join(os.homedir(), ".pi", "agent", "tavily.key"),
	];
	for (const p of candidates) {
		try {
			const v = fs.readFileSync(p, "utf8").trim();
			if (v) return v;
		} catch {
			// 文件不存在或无权限，继续下一个
		}
	}
	return null;
}

async function tavilySearch(
	key: string,
	query: string,
	count: number,
	recency?: string,
	domain?: string,
): Promise<TvItem[]> {
	const body: Record<string, unknown> = {
		query,
		max_results: Math.min(Math.max(count, 1), 20),
		search_depth: TV_DEPTH,
	};
	if (recency && recency !== "noLimit" && RECENCY_TO_RANGE[recency]) {
		// Tavily 的 time_range 对 general topic 过滤过狠（实测常返回 0 条），配合 news topic 才稳定
		body.topic = "news";
		body.time_range = RECENCY_TO_RANGE[recency];
	}
	if (domain) body.include_domains = [domain];

	let resp: Response;
	try {
		resp = await fetch(`${TV_HOST}/search`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		throw new Error(`Tavily：fetch failed（${netDetail(e)}）`);
	}
	if (resp.status === 429) throw new Error("Tavily HTTP 429：超出速率/额度限制（免费 1000 credits/月）");
	if (resp.status === 401 || resp.status === 403) throw new Error(`Tavily 认证失败 (HTTP ${resp.status})：检查 TAVILY_API_KEY`);
	if (!resp.ok) {
		// 非 2xx 时尽量把 body 里的具体原因带出来（如 "Query is too short"）
		let detail = "";
		try {
			const j = (await resp.json()) as TvResponse;
			detail = (typeof j.detail === "string" ? j.detail : j.detail?.error) ?? "";
		} catch {
			// body 不是 JSON，忽略
		}
		throw new Error(`Tavily HTTP ${resp.status}${detail ? `：${detail}` : ""}`);
	}

	const data = (await resp.json()) as TvResponse;
	if (data.detail) {
		const msg = typeof data.detail === "string" ? data.detail : data.detail.error;
		if (msg) throw new Error(`Tavily：${msg}`);
	}
	return data.results ?? [];
}

// ── 结果格式化（统一两通道的输出形态） ──────────────────────────────

function formatFc(items: FcItem[]): string {
	if (!items.length) return "（无搜索结果）";
	return items
		.map((it, i) => {
			const head = `[${i + 1}] ${it.title ?? "(无标题)"}`;
			const link = it.url ? `    ${it.url}` : "";
			const desc = it.description ? `    ${it.description.slice(0, 500)}` : "";
			return [head, link, desc].filter(Boolean).join("\n");
		})
		.join("\n\n");
}

function formatTv(items: TvItem[]): string {
	if (!items.length) return "（无搜索结果）";
	return items
		.map((it, i) => {
			const head = `[${i + 1}] ${it.title ?? "(无标题)"}`;
			const link = it.url ? `    ${it.url}` : "";
			const content = it.content ? `    ${it.content.slice(0, 500)}` : "";
			return [head, link, content].filter(Boolean).join("\n");
		})
		.join("\n\n");
}

// ── 工具参数 ────────────────────────────────────────────────────────

const SEARCH_PARAMS = Type.Object({
	query: Type.String({ description: "搜索关键词，建议精炼（英文源效果更佳）" }),
	count: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 20,
			description: "返回条数，默认 8（Firecrawl 每条消耗 1 credit 左右）",
		}),
	),
	recency: Type.Optional(
		Type.Union(
			[
				Type.Literal("oneDay"),
				Type.Literal("oneWeek"),
				Type.Literal("oneMonth"),
				Type.Literal("oneYear"),
				Type.Literal("noLimit"),
			],
			{ description: "时间范围过滤，默认 noLimit 不限" },
		),
	),
	domain: Type.Optional(
		Type.String({ description: "限定域名白名单，如 docs.github.com（仅返回该站点结果）" }),
	),
});

// ── 扩展入口 ────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI): void {
	let registered = false;

	// session_start 时注册（dynamic-tools 示例的做法）
	pi.on("session_start", () => {
		if (registered) return;
		registered = true;

		pi.registerTool({
			name: "web_search",
			label: "Web Search",
			description:
				"联网搜索（Firecrawl，YouTube/英文源覆盖佳；重试耗尽后自动回退 Tavily）。返回标题、链接与摘要；拿到链接后可用 bash curl 抓全文",
			promptSnippet: `Search the web via Firecrawl (falls back to Tavily). Returns titles, links and snippets.`,
			promptGuidelines: [
				"Use web_search when fresh information from the internet is needed (recent releases, docs you don't have locally, facts that may have changed).",
				"Keep the query concise; English queries work better for international sources.",
				"After finding a relevant URL, prefer curl via bash for full page content.",
			],
			parameters: SEARCH_PARAMS,
			async execute(_toolCallId, params) {
				const { query, count = 8, recency, domain } = params as {
					query: string;
					count?: number;
					recency?: string;
					domain?: string;
				};
				const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

				// ① Firecrawl 主通道（失败自动重试）
				const fcKey = process.env.FIRECRAWL_API_KEY;
				if (fcKey) {
					try {
						const { items, credits, attempts } = await fcSearchWithRetry(fcKey, query, count, recency, domain);
						return {
							content: [{ type: "text", text: formatFc(items) }],
							details: { provider: "firecrawl", count: items.length, creditsUsed: credits, attempts },
						};
					} catch (e) {
						// 落到 Tavily 兜底，但把 Firecrawl 的失败带出来
						const reason = errText(e);
						const fcAttempts = (e as { attempts?: number } | undefined)?.attempts;
						const tvKey = resolveTavilyKey();
						if (!tvKey) {
							return {
								content: [
									{ type: "text", text: `搜索失败：Firecrawl：${reason}；未配置 TAVILY_API_KEY，无法回退 Tavily` },
								],
								details: { provider: "none", fcAttempts },
							};
						}
						try {
							const tvItems = await tavilySearch(tvKey, query, count, recency, domain);
							return {
								content: [
									{ type: "text", text: `（Firecrawl 失败：${reason}，已回退 Tavily）\n\n${formatTv(tvItems)}` },
								],
								details: { provider: "tavily-fallback", count: tvItems.length, fcAttempts },
							};
						} catch (e2) {
							return {
								content: [
									{ type: "text", text: `搜索失败：Firecrawl：${reason}；Tavily 兜底也失败：${errText(e2)}` },
								],
								details: { provider: "both-failed", fcAttempts },
							};
						}
					}
				}

				// ② 无 Firecrawl key，直接 Tavily
				const tvKey = resolveTavilyKey();
				if (!tvKey) {
					return {
						content: [{ type: "text", text: "搜索失败：未配置 FIRECRAWL_API_KEY，也未配置 TAVILY_API_KEY" }],
						details: { provider: "none" },
					};
				}
				try {
					const tvItems = await tavilySearch(tvKey, query, count, recency, domain);
					return {
						content: [{ type: "text", text: formatTv(tvItems) }],
						details: { provider: "tavily", count: tvItems.length },
					};
				} catch (e) {
					return {
						content: [{ type: "text", text: `搜索失败：${errText(e)}` }],
						details: { provider: "tavily-failed" },
					};
				}
			},
		});
	});
}
