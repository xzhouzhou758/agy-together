# AGY Together portal. Zero runtime dependencies: Node 24 runs the TypeScript sources
# directly (type stripping) and uses the built-in node:sqlite.
FROM node:24-alpine
ENV NODE_ENV=production TZ=Asia/Shanghai DATA_DIR=/app/data
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=64", "--max-semi-space-size=2", "src/main.ts"]
