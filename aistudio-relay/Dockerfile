# AI Studio relay: Lianues/aistudio-pg-bridge 2-relay-client-gateway, pinned commit.
FROM node:24-alpine AS src
ARG RELAY_COMMIT=2821bf9d9a0731ed233dcebcaf9bb76219aefb15
RUN apk add --no-cache git && git clone https://github.com/Lianues/aistudio-pg-bridge /src && cd /src && git checkout "$RELAY_COMMIT"
COPY relay-allow.patch /tmp/
RUN cd /src && git apply /tmp/relay-allow.patch

FROM node:24-alpine
ENV NODE_ENV=production TZ=Asia/Shanghai COOKIES_DIR=/app/cookies
RUN apk add --no-cache tzdata
WORKDIR /app
COPY --from=src /src/2-relay-client-gateway/package.json ./
COPY --from=src /src/2-relay-client-gateway/bin ./bin
COPY --from=src /src/2-relay-client-gateway/src ./src
RUN mkdir -p /app/cookies && chown node:node /app/cookies
USER node
CMD ["node", "--max-old-space-size=96", "bin/start-relay.js"]
