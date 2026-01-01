# Polymarket Trading Agent - Railway Deployment
FROM oven/bun:1.1-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy entire monorepo - simpler than individual packages
COPY package.json bun.lock* ./
COPY packages ./packages
COPY tsconfig*.json ./
COPY turbo.json ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Build required packages in order
RUN cd packages/core && bun run build || true
RUN cd packages/plugin-sql && bun run build || true
RUN cd packages/plugin-bootstrap && bun run build || true
RUN cd packages/server && bun run build || true
RUN cd packages/cli && bun run build || true
RUN cd packages/plugin-polymarket && bun run build

# Production image
FROM oven/bun:1.1-alpine AS runner

RUN apk add --no-cache wget

WORKDIR /app

# Copy built packages
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/package.json ./

# Set working directory to plugin
WORKDIR /app/packages/plugin-polymarket

# Railway injects PORT env variable
ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0

EXPOSE 3000

# Health check (120s start-period for slower builds)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-3000}/health || exit 1

# Start command - use PORT from Railway
CMD ["sh", "-c", "SERVER_PORT=${PORT:-3000} bun ../cli/dist/index.js start"]
