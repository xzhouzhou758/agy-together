# agy-scheduler：CLIProxyAPI 选号插件（v0.2.0）

作用：CPA 每次选号都只在门户给出的允许名单里挑号。名单里挑不出可用的号就拒绝（Reject），不会退回 CPA 内置的调度器。

- 锁定版本：CPA **v8.0.40**（commit d946c4f），镜像 `eceasy/cli-proxy-api:v8.0.40`。它和测试机原来跑的 `:latest` 是同一个镜像 ID（sha256:0a0ed62b…），compose 已经改成写死这个 tag。
- 插件 ABI 版本 1，schema 版本 6，go.mod 依赖 `github.com/router-for-me/CLIProxyAPI/v8 v8.0.40`。升级 CPA 时要重新编译插件，再跑一遍下面的测试。

## 构建

镜像基于 Debian 12（glibc 2.36，amd64），所以要在 `golang:1.26-bookworm` 容器里编译：

```sh
# 在 docker 主机上；源码放在 /opt/agy-build/src（main.go go.mod go.sum）
sh test/build.sh /opt/agy-build/src
cp /opt/agy-build/src/agy-scheduler.so /opt/cliproxyapi/plugins/agy-scheduler.so
```

文件名决定插件 ID，必须叫 `agy-scheduler.so`。

## 配置（config.yaml）

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    agy-scheduler:
      enabled: true
      priority: 1
      header: "X-Agy-Allow"        # 默认值
      allow_missing_header: false  # 默认 false：请求不带这个头就拒绝（失败即关闭）
      log_picks: true              # 每次选号往 stderr（docker logs）写一行 JSON
      session_ttl: "1h"            # 会话绑定保留多久（默认 1h；请求头 X-Agy-Session-Ttl 秒数可覆盖，门户目前不发）
      max_sessions: 20000          # 绑定表上限，满了先清过期的，再清最旧的
observability:
  usage:
    usage-statistics-enabled: true # 记账要靠 usage 队列取 token 数
```

## 请求头约定

- 门户转发前：先删掉客户端带来的所有 `X-Agy-Allow`（不分大小写），再写入**恰好一个** `X-Agy-Allow: <id1>,<id2>,...`。
- ID 是 CPA 的 auth ID，也就是凭证文件名（如 `xxx.json`），可从 `GET /v8/management/credentials` 返回的 `files[].id` 拿到。
- 插件从 `SchedulerPickRequest.Options.Headers` 读这个头（实测能收到，不分大小写），用逗号分隔，自动去掉空格和重复项。
- 以下情况一律拒绝：头不存在、出现多次、内容为空或只有逗号空格、条数超过 512、名单和候选号没有交集。
- 从候选号里挑：先限定在允许名单内，再取其中优先级最高的那一层，最后选最久没被用过的号（LRU）。插件声明了 `scheduler_across_priorities`，低优先级层的号也能收到。
- 这个头不会被转发给上游（mock 实测没收到）。
- 拒绝时 CPA 返回的状态码：没有可用号返回 503（`auth_unavailable`），其余拒绝返回 500（错误信息里带 `agy_allow_*`）。门户可以自己再映射成别的状态码。

## 会话绑定与三种模式（v0.2.0，2026-10-25）

门户另外写两个头（客户端带来的 `X-Agy-*` 一律先删掉）：`X-Agy-Session: <32 位十六进制>`（门户算的会话键，不含任何原文）和 `X-Agy-Mode: cache|balance|performance`（用户在「个人中心 → 账号轮换」里选）。插件按 `会话键 + 模型` 记一张绑定表。

| 模式 | 行为 |
| --- | --- |
| `performance` 性能优先 | 和 v0.1 一样：名单内最高优先级层里最久没用的号（LRU），不绑定 |
| `balance` 平衡轮换 | 第一次按 LRU 选号并绑定；之后只要绑定的号还在「名单 ∩ 候选」里就一直用它；不在了就按 LRU 换一个并改绑 |
| `cache` 缓存优先 | 同上，但绑定的号暂时不在（冷却、本次请求已试过、被门户的单号并发上限挡住）时，先用一个固定的「替补」号，绑定不变，号回来后会话回到原号；原号连续 5 分钟（提示缓存的寿命）都用不上，替补转正 |

- 绑定永远在名单内：每次都先求「名单 ∩ 候选」，绑定的号不在里面就不会被选中。
- 拒绝规则不变：没头、头重复、名单为空 / 过长、名单和候选没交集，一律 Reject。
- 没有会话键、模式头缺失或重复 → 按 `performance`。
- 已固定的绑定优先于 CPA 的优先级层（和 CPA 内置 session-affinity 的做法一致）；新绑定仍按最高优先级层选。
- CPA 只在插件返回 `Handled=false` 时才会走内置 session-affinity，所以内置那套在这里永远不生效，绑定全靠插件。
- 插件拿不到请求体，也不能自己等待：「等号恢复」只能靠 CPA 的 `routing.retry`（见下）。

单元测试 `main_test.go`（`go test ./...`）：性能模式在名单内均匀轮换；平衡模式粘住、换号后粘住新号、不同会话分散；缓存模式短暂缺席用替补且回到原号、超过 5 分钟替补转正；两种粘性模式都不越出名单、没交集照样拒绝；TTL 过期、每请求 TTL、表大小有上限；拒绝语义不变、重复的模式头不产生粘性。

## 重试与等待（CPA config.yaml，2026-10-25 起）

```yaml
routing:
  retry:
    request-retry: 2          # 第一轮之后再来 2 轮（只对 403/408/429/5xx 生效）
    max-retry-credentials: 3  # 每轮最多换 3 个号，避免一次故障把大锅饭的号挨个打一遍
    max-retry-interval: 45    # 两轮之间最多等 45 秒冷却；0 = 不等
```

- 每次换号 CPA 都会重新调插件，已试过和冷却中的号不在候选里，所以重试仍只在名单内。
- 等待只发生在「CPA 里所有支持该模型的号都在冷却」时：CPA 算最近的冷却结束时间时看的是全部号，不只是名单内的号；只要还有别的号可用，它就立即开下一轮（这一轮插件找不到名单内的号就拒绝）。
- `max-retry-interval` 支持热更新：门户管理员后台「上游重试 → 最大等待时长」调用 `PUT /v8/management/config/routing/retry/max-retry-interval`，CPA 写回 config.yaml 并自动重载，不用重启。实测写回后文件内容不变（除了这个值）。openresty 对 /xgf/ 的 `proxy_read_timeout` 是 600 秒，所以上限给到 300 秒。

## 选中的号怎么回传给门户

1. **响应头 `X-CPA-TRACE-ID`**：格式是 `<时间>-<auth_index>-<request_id>`，流式和非流式都有。重试之后指向最终成功的那个号，30 个用例里全部对得上。`auth_index` 和 auth ID 的对应关系见 `GET /v8/management/credentials`。
2. **用量队列 `GET /v8/management/observability/usage/queue?count=N`**：每条记录有 `request_id`（就是 trace 里的那段）、`auth_index`、token 数、`failed`。注意队列取出即删除，只能有一个消费者，默认保留 60 秒。
3. 插件日志 `[agy-scheduler] {...}` 只适合排查问题，日志里没有 request_id，不要拿来记账。

## 验证结果（2026-10-24，测试机）

做法：建 5 个假号 `agy-fake-a..e`（`base_url` 指向本地 mock，token 为 `tok-x`，e 只有 gemini-3-flash 一个模型）。mock 跑在 CPA 容器的网络命名空间里，只监听 127.0.0.1:18090，会记录每次上游调用用的 token，还能按需返回 429/500/503。每个用例同时核对三处：mock 记录、响应正文、trace 头。完整输出见 `test/last_run.txt`。

| 用例 | 结果 |
|---|---|
| 普通请求 allow=[a,b] ×6（a/b 交替） | 通过 |
| 流式 allow=[c] ×3；allow=[a,b,d] ×6 | 通过 |
| 名单只有 1 个号 | 通过 |
| 重试（非流式/流式）：a 返回 500、b 返回 429 → 依次 a→b→c 成功 | 通过 |
| 名单内全部失败：4 轮重试只在 a、b 之间转，从不碰 c/d/e | 通过 |
| 换模型：claude 且 allow=[e,a] → 只用 a；allow=[e] → 拒绝；不同模型交替 | 通过 |
| 名单为空 / 只有逗号 / 全是不存在的 ID → 拒绝，上游零调用 | 通过 |
| 不存在的 ID 加 d → 只用 d | 通过 |
| 不带头 / 头重复 → 拒绝 | 通过 |
| 头名小写也能识别 | 通过 |
| /v1/messages、/v1beta 原生（含流式）、/v1/responses | 通过 |
| count_tokens 不带头 → 拒绝 | 通过 |
| 开启冷却：a 被 429 进入冷却后 allow=[a] → 拒绝（503），allow=[a,b] → 用 b | 通过 |
| 并发 24 个请求，两组互不相交的名单，流式与非流式混合 | 通过（零越界，6/6/6/6 均匀分布） |

重试时 Pick 会被重新调用：每次重试 CPA 都会再调一次插件，已经试过的号从候选里去掉（日志里 candidates 逐次变少）。流式请求在发出第一个字节之前的重试也一样。

## 已知风险（门户必须处理）

1. **插件没生效时会放行**：插件被禁用、注册失败（例如元数据缺字段）、加载失败或因 panic 被熔断时，CPA 会悄悄改用内置调度器，任意号都可能被用。这一点已实测：禁用插件后，不带头的请求直接返回 200。门户必须做两件事：
   - 转发前检查 `GET /v8/management/plugins`，要求 `agy-scheduler` 的 `registered` 和 `effective_enabled` 都为 true；
   - 每个响应都核对 `X-CPA-TRACE-ID` 里的 auth_index 是否在本次名单内，不在就报警并熔断。
2. **8317 端口不能让客户端直连**：持有 CPA API Key 的人可以自己写这个头，随便选号。上线后 CPA 只监听 127.0.0.1，只有门户持有 CPA 的 Key 和管理密钥。
3. **Home（集群）模式会绕过插件**，不要开启。管理接口 `/requests/api-call` 可以用任意号发请求，所以管理密钥只能由门户持有。
4. 失败的重试也会真实调用名单内的其他号（会消耗它们的额度），用量队列里对应记录的 `failed=true`。

## 测试文件（test/）

- `build.sh`：构建插件。
- `mock_upstream.py`：mock 上游。
- `setup_fake.sh` / `teardown_fake.sh`：创建 / 删除假号和 mock。
- `run_tests.py`：测试脚本，在 docker 主机上运行：`set -a; . /opt/cliproxyapi/secrets.env; set +a; python3 -I /opt/agy-test/run_tests.py`。
- `last_run.txt`：最近一次的完整输出。

## 宿主内部请求全部放开（2026-10-25）

其他插件通过 `host.model.execute` 发起的请求（例如 Lamplighter 的自动点火）不带 `X-Agy-Allow`，也没有 `caller_scope`（不是带 API Key 的客户端请求）。这类请求一律放行，可用任意账号：
- 有 `pinned_auth_id` 且该账号在候选里 → 直接用它（日志 reason=`host_pinned`）；
- 否则交给 CPA 内置调度（reason=`host_internal`），调用方拿到的是 CPA 自己的结果/报错。

带 `X-Agy-Allow` 的请求仍按名单走；客户端请求总有 caller_scope，缺名单照样拒绝。

