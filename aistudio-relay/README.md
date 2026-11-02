# aistudio-relay

门户「AI Studio」池的上游：[Lianues/aistudio-pg-bridge](https://github.com/Lianues/aistudio-pg-bridge) 的 `2-relay-client-gateway`，固定在 commit `35c7843`。只监听 127.0.0.1:18802，Cookie 存在 `./cookies`。签名服务默认用作者的 `waa.spinsnow.fun`。

构建时打上 `relay-allow.patch`：请求头 `X-Relay-Allow` 限定可用的号，响应头 `X-Relay-Account` 报告实际用的号。门户依赖这两个头，不打补丁的中转会让 AI Studio 聊天请求全部 502。

```sh
cp relay.env.example relay.env      # 改 RELAY_API_KEY，权限 600
mkdir -p cookies && chown 1000:1000 cookies && chmod 700 cookies
docker compose up -d --build
```

门户 `portal.env` 里加 `AISTUDIO_RELAY_KEY=<同一个 RELAY_API_KEY>` 后重启门户，侧栏出现「AI Studio」。号由门户管理，不要在中转面板里手动加号（复检会删掉门户不认识的号）。
