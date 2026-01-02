FROM node:22.12.0-slim AS builder

WORKDIR /app

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ffmpeg \
    g++ \
    git \
    make \
    python3 \
    unzip \
    ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install bun and turbo with latest stable versions
RUN npm install -g bun@1.2.21 turbo@2.3.3

RUN ln -s /usr/bin/python3 /usr/bin/python

COPY package.json turbo.json tsconfig.json lerna.json renovate.json .npmrc build-utils.ts ./
COPY scripts ./scripts
COPY packages ./packages

RUN SKIP_POSTINSTALL=1 bun install --no-cache

# Add verbose logging and memory monitoring for build diagnostics
RUN echo "=== Build Environment Info ===" && \
    echo "Node version: $(node --version)" && \
    echo "Bun version: $(bun --version)" && \
    echo "CPU info: $(nproc) cores" && \
    echo "Disk space: $(df -h /)" && \
    echo "=== Starting Build ===" && \
    TURBO_CONCURRENCY=2 bun run build --concurrency=2 --verbosity=1 || (echo "=== Build Failed - System State ===" && df -h / && exit 1)

FROM node:22.12.0-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    git \
    python3 \
    unzip \
    ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install bun and turbo
RUN npm install -g bun@1.2.21 turbo@2.3.3

COPY --from=builder /app/package.json ./
COPY --from=builder /app/turbo.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/lerna.json ./
COPY --from=builder /app/renovate.json ./
COPY --from=builder /app/build-utils.ts ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts

# Install external plugins from npm that aren't in the monorepo
RUN bun add @elizaos/plugin-anthropic@latest --no-save || echo "Plugin install completed"

ENV NODE_ENV=production
# Trust proxy for Railway/cloud deployments (fixes X-Forwarded-For header issues)
ENV TRUST_PROXY=1

EXPOSE 3000
EXPOSE 50000-50100/udp

# Run as project - loads polymarketPlugin with all services, actions, providers, and evaluators
# The project's index.ts defines the Zeracle character + polymarket plugin together
WORKDIR /app/packages/plugin-polymarket
CMD ["bun", "../cli/dist/index.js", "start"]
