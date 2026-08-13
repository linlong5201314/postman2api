FROM oven/bun:1.3.8-slim AS dashboard-build

WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/bun.lock ./
# Railway may provide NODE_ENV=production during the image build. The
# dashboard typecheck and Vite build require its devDependencies.
RUN NODE_ENV=development bun install --frozen-lockfile
COPY dashboard/ ./
RUN bun run typecheck && bun run build

FROM oven/bun:1.3.8-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1930 \
    DATABASE_PATH=/app/data/postman2api.db \
    PYTHON_PATH=/app/scripts/auth/.venv/bin/python \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ENABLE_BROWSER_LOGIN=false

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

RUN python3 -m venv scripts/auth/.venv \
    && scripts/auth/.venv/bin/pip install --no-cache-dir -r scripts/auth/requirements.txt \
    && scripts/auth/.venv/bin/python -m playwright install --with-deps chromium \
    && scripts/auth/.venv/bin/python -m playwright install-deps firefox \
    && apt-get update \
    && apt-get install -y --no-install-recommends xvfb fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/bun \
    && HOME=/home/bun scripts/auth/.venv/bin/python -m camoufox fetch \
    && chown -R bun:bun /home/bun \
    && mkdir -p /app/data \
    && chown -R bun:bun /app \
    && chown -R bun:bun /ms-playwright

USER root
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod 0755 ./scripts/docker-entrypoint.sh

EXPOSE 1930
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/health');if(!r.ok)process.exit(1)"]

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
