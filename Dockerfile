# syntax=docker/dockerfile:1
ARG BUN_IMAGE=oven/bun:1.4.4-alpine

FROM ${BUN_IMAGE} AS base
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

FROM base AS build
RUN bun install --frozen-lockfile
COPY . .
RUN DB_PROVIDER=mysql DATABASE_URL=mysql://build:build@127.0.0.1:3306/build bun run db:generate
RUN bun run --filter '@anyone-im/web' build \
 && bun build apps/server/src/index.ts --target bun --minify --outdir apps/server/dist --external '../generated/client'

# Production node_modules only serve `bun run db:push` (Prisma CLI) and the contracts package;
# the server itself runs from the bundle above.
FROM base AS deps
RUN bun install --frozen-lockfile --production --filter '@anyone-im/server' \
 && cd node_modules/.bun \
 && rm -rf @prisma+client@* typescript@* hono@* socket.io* engine.io* ws@* @socket.io+* \
      prisma@*/node_modules/prisma/prisma-client \
      prisma@*/node_modules/prisma/libquery_engine-* \
 && find . \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' \) -type f -delete

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
RUN apk add --no-cache openssl && mkdir -p /data/uploads && chown -R bun:bun /data
COPY --from=deps /app /app
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/generated apps/server/generated
COPY --from=build /app/apps/server/prisma apps/server/prisma
COPY --from=build /app/apps/server/scripts apps/server/scripts
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/contracts/src packages/contracts/src
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 DB_PROVIDER=mysql DATA_DIR=/data
USER bun
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.PORT||4100}/readyz`);process.exit(r.ok?0:1)'
CMD ["bun", "apps/server/dist/index.js"]
