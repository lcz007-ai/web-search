# web-search

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展：给 agent 提供联网搜索工具 `web_search`（pi 本身无内置联网搜索）。

Firecrawl 主通道 + Tavily 自动兜底，返回标题、链接与摘要；拿到链接后建议用 `curl` 抓全文。

## 通道

| 通道 | API | 计费 | 说明 |
|---|---|---|---|
| ① 主通道 | [Firecrawl](https://firecrawl.dev) `/v2/search` | credits | YouTube / 英文源覆盖佳；失败先重试（默认 3 次指数退避：500/1000/2000ms）；401/402/403（认证/额度）与 429（分钟级限流）不重试，直接回退 |
| ② 兜底 | [Tavily](https://tavily.com) `/search` | credits（免费 1000/月） | basic 1 credit/次，advanced 2 credits/次 |

## 安装

```bash
cp web-search.ts ~/.pi/agent/extensions/
# pi 中执行 /reload 热重载
```

## 配置

**密钥（环境变量）**

- `FIRECRAWL_API_KEY`（`fc-` 开头）——未设置则跳过主通道
- `TAVILY_API_KEY`（`tvly-` 开头）——也支持密钥文件 `~/.pi/tavily.key`（改文件无需重启进程）

**可选**

| 变量 | 默认 | 说明 |
|---|---|---|
| `FIRECRAWL_SEARCH_HOST` | `https://api.firecrawl.dev` | 主通道地址 |
| `FIRECRAWL_RETRY_COUNT` | 3 | 主通道重试次数（不含首次） |
| `FIRECRAWL_RETRY_BASE_MS` | 500 | 重试指数退避基数 |
| `TAVILY_SEARCH_HOST` | `https://api.tavily.com` | 兜底地址 |
| `TAVILY_SEARCH_DEPTH` | `advanced` | `basic` 省 credits |
| `TAVILY_SEARCH_TIMEOUT_MS` | 20000 | 请求超时 |

## 工具参数

```json
{
  "query":   "搜索关键词，建议精炼（英文源效果更佳）",
  "count":   8,                    // 1-20，Firecrawl 每条约 1 credit
  "recency": "oneDay | oneWeek | oneMonth | oneYear | noLimit",
  "domain":  "docs.github.com"     // 可选，限定域名白名单
}
```

## 实现细节

- undici 网络层错误 message 恒为 `fetch failed`，扩展会解出真实原因（`ECONNRESET` / `ENOTFOUND` 等）并透传
- Tavily 的 `time_range` 对 general topic 过滤过狠（实测常返回 0 条），故 recency 过滤自动配合 `topic: news` 使用
- 非 2xx 时尽量把响应体里的具体原因带出来（如 `"Query is too short"`）
- 扩展内不含任何密钥；密钥只从环境变量 / 密钥文件读取

## 说明

- 若两个通道都失败，返回 `both-failed` 并带出两侧错误原因，由 agent 决定是否向用户说明
- 密钥不会出现在搜索结果与日志中
