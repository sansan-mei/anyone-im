FROM oven/bun:1.4.4 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN DB_PROVIDER=mysql DATABASE_URL=mysql://build:build@127.0.0.1:3306/build bun run db:generate
RUN bun run build

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /data/uploads && chown -R bun:bun /data
COPY --from=build --chown=bun:bun /app /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 DB_PROVIDER=mysql DATA_DIR=/data
USER bun
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.PORT||4100}/readyz`);process.exit(r.ok?0:1)'
CMD ["bun", "run", "apps/server/src/index.ts"]
