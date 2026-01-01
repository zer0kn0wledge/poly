# Polymarket Trading Agent - Railway Deployment
FROM oven/bun:1.1-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ git bash

WORKDIR /app

# Copy entire monorepo structure
COPY package.json bun.lock* ./
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./
COPY turbo.json ./

# Create empty plugin-specification dir if needed (for workspaces)
RUN mkdir -p plugin-specification

# Install dependencies (ignore postinstall script issues)
RUN bun install --ignore-scripts || true
RUN bun install --ignore-scripts

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

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-3000}/health || exit 1

# Start command
CMD ["sh", "-c", "SERVER_PORT=${PORT:-3000} bun ../cli/dist/index.js start"]
