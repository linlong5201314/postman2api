# postman2api

Standalone Bun service that exposes Postman's agent chat API through OpenAI- and Anthropic-compatible endpoints. It provides an authenticated admin dashboard, multi-account pooling, encrypted account tokens, and per-account HTTP/HTTPS upstream proxies.

> Educational and research use only. Check the upstream service terms and applicable law before using it. No code can guarantee unlimited quota, account lifetime, or resistance to provider-side controls.

## Local setup

Requirements: Bun 1.3.8 or newer. Python/Playwright is optional and only needed for local browser login.

```bash
bun install
cd dashboard && bun install && cd ..
cp .env.example .env
bun run build
bun start
```

The server runs migrations automatically. Open `http://localhost:1930`, then sign in with `ADMIN_KEY` from `.env`. Production startup rejects missing or weak secrets.

For reliable account setup, use the Dashboard's manual token import. The Railway image includes headless Chromium for direct email/password login when `ENABLE_BROWSER_LOGIN=true`, but MFA, CAPTCHA, SSO, and OAuth accounts still require manual token import.

## Proxies

Open **Proxies** in the Dashboard to batch import, test, enable/disable, delete, and assign proxies to accounts. One proxy per line is accepted:

```text
http://user:password@host.example:8080
host.example:8081
host.example:8082:user:password
user:password@host.example:8083
```

Only HTTP and HTTPS upstream proxies are supported. SOCKS4/SOCKS5 lines are rejected explicitly. URLs and credentials are encrypted in SQLite; management responses show only masked values. For Railway, use the private multiline `PROXY_BOOTSTRAP` variable to import on startup.

## API usage

```bash
# OpenAI-compatible
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# Anthropic-compatible
curl http://localhost:1930/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

Available models are returned by authenticated `GET /v1/models`.

## Railway

Railway deployment uses the root `Dockerfile` and must remain a single replica while SQLite is used. Mount a Volume at `/app/data`, set `DATABASE_PATH=/app/data/postman2api.db`, and set `REQUIRE_PERSISTENT_STORAGE=true`.

See [docs/RAILWAY.md](docs/RAILWAY.md) for variables, proxy bootstrap, health checks, and deployment steps. Redis is not required.

## Verification

```bash
bun run check
bun run test:coverage
```

`bun run check` runs backend and Dashboard type checks, tests, and the production Dashboard build.
