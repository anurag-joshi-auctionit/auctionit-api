# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Enable corepack so pnpm is available at the pinned version from package.json
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

# Copy workspace manifests first for layer-cached installs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/authz/package.json        packages/authz/
COPY packages/lib/package.json          packages/lib/
COPY packages/messages/package.json     packages/messages/
COPY packages/xlsx-export/package.json  packages/xlsx-export/
COPY packages/xlsx-import/package.json  packages/xlsx-import/

# Install all deps (including devDependencies needed for tsc)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Compile workspace packages first (their dist/ is needed at runtime)
RUN pnpm -r --filter './packages/*' build

# Compile TypeScript → dist/
RUN pnpm build

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/authz/package.json        packages/authz/
COPY packages/lib/package.json          packages/lib/
COPY packages/messages/package.json     packages/messages/
COPY packages/xlsx-export/package.json  packages/xlsx-export/
COPY packages/xlsx-import/package.json  packages/xlsx-import/

# Install production deps only (creates workspace symlinks packages/* → node_modules/@auctionit/*)
RUN pnpm install --frozen-lockfile --prod

# Copy compiled workspace package outputs so the symlinks resolve to JS at runtime
COPY --from=builder /app/packages/authz/dist      packages/authz/dist
COPY --from=builder /app/packages/messages/dist   packages/messages/dist
COPY --from=builder /app/packages/lib/dist        packages/lib/dist
COPY --from=builder /app/packages/xlsx-export/dist packages/xlsx-export/dist
COPY --from=builder /app/packages/xlsx-import/dist packages/xlsx-import/dist

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy openapi.json (served by Swagger UI at runtime)
COPY --from=builder /app/openapi.json ./openapi.json

# Copy public assets if any
COPY --from=builder /app/public ./public

EXPOSE 4000

ENV NODE_ENV=production

# Default: run the API server
# Override CMD to run the email worker:
#   docker run <image> node dist/workers/email-worker.js
CMD ["node", "dist/index.js"]
