# syntax=docker/dockerfile:1
ARG BUN_IMAGE=oven/bun:1.4.4-alpine

# Compile JavaScript on the builder CPU to avoid running Bun/Vite under emulation.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS base
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

FROM base AS build
RUN apk add --no-cache nodejs
RUN bun install --frozen-lockfile
COPY . .
# Bun still resolves the generated client while bundling external imports.
# This build-platform client is only used for bundling, never copied to runtime.
RUN DB_PROVIDER=mysql DATABASE_URL=mysql://build:build@127.0.0.1:3306/build bun run db:generate
RUN cd apps/web && node node_modules/vite/bin/vite.js build && cd /app \
 && bun build apps/server/src/index.ts --target bun --minify --outdir apps/server/dist --external '../generated/client'
# Production node_modules only serve `bun run db:push` (Prisma CLI) and the contracts package;
# the server itself runs from the bundle above.
# Native Prisma engines and production dependencies must match the runtime CPU.
FROM --platform=linux/amd64 ${BUN_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/server/prisma apps/server/prisma
COPY apps/server/scripts apps/server/scripts
RUN bun install --frozen-lockfile --production --filter '@anyone-im/server' \
 && DB_PROVIDER=mysql DATABASE_URL=mysql://build:build@127.0.0.1:3306/build bun run db:generate \
 && cd node_modules/.bun \
 && rm -rf @prisma+client@* typescript@* hono@* socket.io* engine.io* ws@* @socket.io+* \
      prisma@*/node_modules/prisma/prisma-client \
      prisma@*/node_modules/prisma/libquery_engine-* \
      prisma@*/node_modules/prisma/build/public \
 && find . \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' \) -type f -delete

# The generated client uses the native library engine. Its WASM engines/compiler
# variants and source maps are not used by the bundled Bun server.
RUN find apps/server/generated -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name 'query_engine_bg.*' -o -name 'query_compiler_bg.*' \) -delete

# The published image is always Linux x86-64.
FROM --platform=linux/amd64 ${BUN_IMAGE} AS runtime
WORKDIR /app
RUN apk add --no-cache openssl && mkdir -p /data/uploads && chown -R bun:bun /data
COPY --from=deps /app /app
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/contracts/src packages/contracts/src
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 DB_PROVIDER=mysql DATA_DIR=/data
USER bun
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.PORT||4100}/readyz`);process.exit(r.ok?0:1)'
CMD ["bun", "apps/server/dist/index.js"]
