# AGY Together

朋友之间合用 Antigravity（Google）账号的小锅饭 / 大锅饭门户。

```
客户端 ──▶ 门户 (127.0.0.1:8320) ──▶ CLIProxyAPI v8.0.40 + agy-scheduler 插件 ──▶ Google
                 └──▶ 外部上游（可选，如 Antigravity Manager）
```

- **小锅饭**：只用自己的号。
- **大锅饭**：大家共享的号轮流用，每人每天有次数（基础 + 共享 Pro 号加成），号主可设自用保留。
- Discord 登录（可要求服务器成员 / 身份组），也支持管理员建的账号密码。
- 凭证管理：Google OAuth、Refresh Token、JSON / ZIP 批量导入导出，额度、模型测试。
- 流量日志、Token 统计、公告、Discord 机器人（号出问题 @ 号主、/我的号、/今日榜、日报）。
- 403 的号自动停用并定期探测恢复；每日备份。

| 目录 | 内容 |
| --- | --- |
| `portal/` | 门户（Node 24 直接跑 TypeScript，`node:sqlite`，零运行时依赖），见 `portal/README.md` |
| `scheduler/` | CLIProxyAPI 选号插件 `agy-scheduler`（Go，c-shared），见 `scheduler/README.md` |
| `install.sh` | 一键安装 |

## 一键安装

要求：Linux amd64、root、能访问 Docker Hub。没有 Docker 会自动安装。

```bash
curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-together/main/install.sh | sudo bash -s -- --domain pot.example.com
```

脚本会自动把本仓库最新代码下载到 `/opt/agy-together/src` 再安装。也可以先 clone 再在仓库里运行 `sudo ./install.sh --domain pot.example.com`。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--domain pot.example.com` | 站点域名，用来生成站点地址和 Discord 回调地址 |
| `--base-path /xgf` | 挂在子路径下（默认站点根路径） |
| `--port 8320` | 门户在 127.0.0.1 上的端口 |
| `--nginx` | 顺便写一份 nginx 站点配置（需已安装 nginx；HTTPS 自己用 certbot 加） |
| `--plugin-so ./agy-scheduler.so` | 用现成的插件，不在本机编译 |

脚本会：

1. 安装 CLIProxyAPI 到 `/opt/cliproxyapi`，随机生成 API Key 和管理密钥（存在 `secrets.env`，权限 600），只监听 127.0.0.1。
2. 用 `golang:1.26-bookworm` 编译 `agy-scheduler.so` 并装进 CPA（首次会拉约 1 GB 镜像）。
3. 安装门户到 `/opt/agy-pot`，写好 `portal.env`，构建并启动。
4. 每天 04:17 备份数据库、凭证和配置到 `/root/agy-backups`（保留 7 份）。
5. 最后打印 **Setup Token**：打开 `<站点>/setup`，填 Discord 应用信息和你自己的 Discord ID（成为管理员）。

重复运行是安全的：已有的密钥、配置、凭证和数据都会保留，只更新代码。

所有服务只监听本机，需要你自己在前面放一个 HTTPS 反向代理指向 `127.0.0.1:8320`（`proxy_buffering off`，超时 600 秒以上）。

## 开发

```bash
cd portal && npm test          # 门户：mock CPA 的端到端测试
cd scheduler && go test ./...  # 插件单元测试
```
