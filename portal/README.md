# agy-pot：AGY Together 小锅饭门户

门户后端 + 前端，单个容器。浏览器和客户端都只连门户；只有门户持有 CLIProxyAPI（CPA）的 API Key 和管理密钥。

```
浏览器 / 客户端 ──▶ 门户 127.0.0.1:8320 ──▶ CPA 127.0.0.1:8317（agy-scheduler 插件）──▶ Google
```

- Node 24 直接运行 TypeScript 源码（类型擦除），数据库用内置 `node:sqlite`。**运行时零依赖**，不需要构建步骤。
- 前端是 `public/` 下的静态文件（`index.html` + `app.css` + `app.js`），由原型改成真实页面：去掉了“演示”标签、评审浮层和 localStorage 演示数据，全部走真实接口。CSP：`script-src 'self'; connect-src 'self'`，页面里没有内联脚本。

## 目录

```
agy-pot/
├── src/            后端（main / api / gateway / auth / cpa / quota / usage / site / db / zip / routing / reason）
├── public/         前端（index.html、app.css、app.js、theme.js、setup.html、setup.js）
├── test/           本地测试：mock-cpa.ts + portal.test.ts + routing.test.ts（npm test）
├── deploy/         docker-compose.yml（门户）、cpa-docker-compose.yml（CPA）、portal.env.example
└── Dockerfile
```

## 网关做了什么

每个 `/v1/*`、`/v1beta/*` 请求：

1. 校验门户密钥（`Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 或 `?key=` 都认）。数据库只存 SHA-256，明文只在创建时显示一次。
2. 熔断状态检查；然后检查 CPA `GET /v8/management/plugins` 里 `agy-scheduler` 的 `registered && effective_enabled`（缓存 3 秒，查不到一律拒绝）。
3. 算出允许名单：
   - 小锅饭：密钥主人自己的、CPA 里未停用的号。
   - 大锅饭：已共享、未停用、主人未被停用、没跌破自用保留、当前在途数未达单号并发上限的号。
   - 大锅饭密钥还要过“总并发 / 每分钟次数”两道限制，超了返回 429。
4. 删掉客户端带来的所有 `X-Agy-*`（任意大小写、任意份数）以及凭证类、转发类请求头，写入**恰好一个** `X-Agy-Allow`，换成 CPA 的 API Key 转发。流式原样透传（不缓冲）。
5. 在第一个字节回给客户端之前，解析 `X-CPA-TRACE-ID` 里的 auth_index，换算成账号 ID：
   - 不在名单里（或成功的生成请求没有 trace）→ 记告警、掐断上游、给客户端 502，并**熔断整个网关**，直到管理员在后台“解除熔断”。
   - `X-CPA-TRACE-ID` 不会回给客户端。
6. 记账：每个请求一行（时间、用户、密钥、池、实际账号、主人、模型、状态、结果、耗时、是否流式、request_id）。后台单线程每 3 秒取一次 CPA 用量队列，按 request_id 回填 token；同时再核对一遍队列里每次尝试（包括失败重试）的 auth_index 是否在名单内，不在也熔断。**不存请求和回复内容。**
7. 大锅饭调用方在记录里只能看到“共享账号 #NN”，看不到邮箱、账号 ID、令牌；贡献者只看到次数、模型分布和 token，看不到调用者。

## 配置（环境变量）

写在 `/opt/agy-pot/portal.env`（权限 600）。Discord 相关的设置**推荐在网页上填**（首次初始化页 + 管理员后台），环境变量只作为默认值。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CPA_URL` | `http://127.0.0.1:8317` | CPA 地址 |
| `CPA_API_KEY` | 必填 | CPA `access.api-keys` 里的一把 |
| `CPA_MANAGEMENT_KEY` | 必填 | CPA `management.secret-key` 的明文 |
| `HOST` / `PORT` | `127.0.0.1` / `8320` | 监听地址（compose 里已固定为 127.0.0.1:8320） |
| `COOKIE_SECURE` | `1` | 会话 Cookie 带 Secure；只在本机 http 调试时设 0 |
| `PUBLIC_URL` | 空 | 站点地址，如 `https://pot.example.com`；网页上也能改 |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_REDIRECT_URI` / `DISCORD_GUILD_ID` / `DISCORD_ROLE_IDS` / `DISCORD_BOT_TOKEN` | 空 | 可选，网页上填过的值优先 |
| `ADMIN_DISCORD_IDS` | 空 | 额外的管理员 Discord ID（逗号分隔），与网页上设置的合并 |
| `ROLE_RECHECK_MINUTES` | `30` | 有机器人 Token 时，每隔多久复核一次身份组；0 关闭 |
| `QUOTA_REFRESH_MINUTES` | `15` | 后台刷新**已共享**账号配额的间隔；0 关闭（用户仍可手动刷新） |
| `QUOTA_BASE_URL` | `https://daily-cloudcode-pa.googleapis.com` | 配额接口地址（测试时指向 mock） |
| `QUOTA_USER_AGENT` | `antigravity/hub/2.26.0 (…)` | 配额请求的 UA |
| `SESSION_DAYS` | `14` | 登录有效期 |
| `USAGE_RETENTION_DAYS` | `90` | 记录保留天数 |
| `MAX_BODY_MB` | `50` | 单个请求体上限 |
| `DEV_LOGIN` | 关 | **仅测试**：免 Discord 登录。绑定非回环地址时拒绝启动 |

## 首次初始化（/setup）

没人能在 Discord 配好之前登录，所以第一次启动时：

1. 门户生成一次性 **Setup Token**，写进 `/opt/agy-pot/data/setup-token`（权限 600，目录 700）并打印到容器日志：
   ```sh
   cat /opt/agy-pot/data/setup-token      # 或 docker logs agy-pot | grep setup
   ```
2. 打开 `https://<你的子域名>/setup`，填：Setup Token、站点地址、Client ID、Client Secret、Guild ID、Role IDs、（可选）Bot Token、你自己的 Discord 用户 ID（成为管理员）。
3. 页面会显示 **Redirect URI**（`<站点地址>/auth/discord/callback`），复制它到 Discord 开发者后台 → 你的应用 → OAuth2 → Redirects。
4. 提交后 `/setup` 立即关闭（返回 404），Token 文件删除。之后用 Discord 登录。

之后所有 Discord 设置都在 **管理员后台 → Discord 登录** 里改，保存即生效，不用重启。Client Secret 和 Bot Token 只能写不能读：保存后只显示“已设置”和“替换”按钮，任何接口都不会返回它们。

登录逻辑照搬 new-api-custom `oauth/discord.go`：scope `identify guilds guilds.members.read`，要求是指定服务器成员；配置了 Role IDs 时至少持有其中一个。


## 账号轮换、错误原因、流量日志字段（2026-10-25 第二批）

### 账号轮换（每个用户自己选）

- 「个人中心 → 账号轮换」：缓存优先 / 平衡轮换 / 性能优先（默认平衡轮换），存在 `users.rotation_mode`；旁边的「清除会话绑定」换一个新的 `users.session_salt`，这个用户之后的会话键全部变掉，插件里的旧绑定不会再被命中（1 小时后自然过期）。
- 小锅饭和大锅饭的密钥都用调用者自己的设置。模式只决定「名单内由哪个号来服务」，不增加请求量；大锅饭的总并发、限速、单号并发、自用保留仍由门户在算名单时强制，所以不影响公平。
- 网关给 CPA 写 `X-Agy-Mode` 和 `X-Agy-Session`（客户端带来的 `X-Agy-*` 一律先删）。会话 TTL 用插件默认 1 小时，门户不发 `X-Agy-Session-Ttl`。
- **会话键**（`src/routing.ts`）：按顺序取第一个有的来源——
  1. CPA 也认的显式会话头：`X-Claude-Code-Session-Id`、`Session-Id`、`Session_id`、`X-Session-Id`、`X-Session-Affinity`、`X-Conversation-Id`、`X-Thread-Id`、`Thread-Id`；
  2. 请求体 `prompt_cache_key`；
  3. Claude 的 `metadata.user_id`（新版 JSON 里的 `session_id`，旧版 `..._session_<uuid>` 的尾巴）；
  4. 兜底：第一段 system / developer / instructions / systemInstruction 加第一条 user 消息（OpenAI、Anthropic、Responses、Gemini 四种格式）。
  
  然后 `sha256("agy-session:v1", 用户盐, 门户密钥 id, 模型组, 来源, 值)` 取前 32 位十六进制。同一会话后续轮次不变；不同会话、不同密钥、不同模型组（Claude / Gemini Pro / Gemini Flash）都不同。原文不进日志、不进数据库。什么都取不到时不发会话头，模式按 `performance`。

### 模型名

不做映射：客户端发什么名字就原样转给 CPA（曾评估过 CPA 的 `oauth-model-alias`：只能精确匹配、要改 CPA 配置，而且门户的配额分组和「没有支持该模型的账号」都需要知道真实名字）。名字不对时会得到下面的明确原因。流量日志同时记「请求的名字」（CPA 用量队列的 `alias`）和「实际的名字」（`model`，`response_model` 不同时取后者）。

### 错误原因（中文，按端点格式）

`src/reason.ts`。`/v1/messages` 返回 Anthropic 格式（`{type:"error",error:{type,message}}`），`/v1beta/...` 返回 Gemini 格式（`{error:{code,message,status}}`），其它返回 OpenAI 格式。能算出恢复时间时带 `Retry-After`。同样的文字写进 `usage.reason`，流量日志里直接显示。

| 情况 | 状态码 | 例子 |
| --- | --- | --- |
| 没有支持该模型的号（CPA 报 unknown provider / 号的模型列表里都没有） | 404 | 没有支持该模型的账号：claude-haiku-4-5-20251001 |
| 名下没号 / 大锅饭没号 / 号都停用 | 503 | 你还没有自己的账号：小锅饭 Key 只用你自己的凭证…… |
| 额度用完（按模型组看门户缓存的 5 小时 / 周额度和 fetchAvailableModels 分组） | 429 | 你的账号 Claude 额度已用完，约 2 小时 15 分后恢复 |
| 号都在 CPA 冷却里 | 429 | 大锅饭的账号 Claude 暂时被上游限流，正在冷却，约 3 分钟后恢复 |
| 大锅饭号都低于自用保留线 / 都在忙 | 503 | 大锅饭的账号都在忙（每个号最多同时 2 个请求），请稍后重试 |
| 大锅饭密钥限速 | 429 | 大锅饭限速：每分钟 60 次 / 大锅饭限速：同时最多 8 个请求 |

CPA 的 429 和「无可用号」类错误会先被网关读完（错误体很小，不影响正常流式），再换成上面的文字；其它 4xx / 5xx 原样透传。

### 流量日志字段

`usage` 新增列（沿用 `pragma_table_info` 判断后 `ALTER TABLE` 的迁移方式）：`requested_model`、`upstream_model`、`reasoning_tok`（不再并进 `out_tok`）、`cache_write_tok`、`attempts`（同一 request_id 的队列记录数 = 上游尝试次数）、`cpa_ttft_ms`、`cpa_latency_ms`、`upstream_status`（最后一次失败尝试的 `fail.status_code`；`fail.body` 永不存）、`reasoning_effort`、`reason`。`users` 新增 `rotation_mode`、`session_salt`。

表格按这些字段重排：时间 | 结果（状态码 + 流式 / 重试 ×N 徽标 + 原因）| 模型（请求名，实际名不同时下面一行「→ 实际」）| 端点 | 用户 / Key | 账号（池 + 账号）| 入 / 出 / 思考（缓存读写非 0 才显示）| 耗时 / 首字（优先用 CPA 的 `ttft_ms`）。搜索也匹配实际模型名和原因。隐私规则不变：普通用户只看自己的行，别人的大锅饭号只显示「共享账号 #NN」；分页和筛选仍在服务器端。

### 管理员：上游重试

后台新卡片「上游重试」：显示 CPA 的重试轮数和每轮换号上限，「最大等待时长」可直接改（`GET/PUT /api/admin/retry` → CPA `/v8/management/config/routing/retry`，CPA 热重载）。当前值：`request-retry: 2`、`max-retry-credentials: 3`、`max-retry-interval: 45`。


部署见仓库根目录的 `README.md` 和 `install.sh`。
