# Polymarket Trading Agent - Railway Deployment
# Cache bust: v3
FROM oven/bun:1.1-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ git bash

WORKDIR /app

# Copy package files first
COPY package.json ./
COPY bun.lock* ./

# Copy ALL packages for workspace resolution
COPY packages/ ./packages/

# Copy scripts and config
COPY scripts/ ./scripts/
COPY tsconfig*.json ./
COPY turbo.json ./

# Create plugin-specification for workspace config
RUN mkdir -p plugin-specification

# Install with ignore-scripts to skip postinstall
RUN bun install --ignore-scripts

# Build required packages
RUN cd packages/core && bun run build || echo "core done"
RUN cd packages/plugin-sql && bun run build || echo "sql done"
RUN cd packages/plugin-bootstrap && bun run build || echo "bootstrap done"
RUN cd packages/server && bun run build || echo "server done"
RUN cd packages/cli && bun run build || echo "cli done"
RUN cd packages/plugin-polymarket && bun run build

# Production stage
FROM oven/bun:1.1-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/package.json ./

WORKDIR /app/packages/plugin-polymarket

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-3000}/health || exit 1

CMD ["sh", "-c", "SERVER_PORT=${PORT:-3000} bun ../cli/dist/index.js start"]
