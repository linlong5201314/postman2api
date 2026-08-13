import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

async function read(relativePath: string): Promise<string> {
  return Bun.file(resolve(root, relativePath)).text();
}

describe("deployment contract", () => {
  test("Railway deploys one Docker replica and waits for readiness", async () => {
    const railway = JSON.parse(await read("railway.json"));

    expect(railway.build.builder).toBe("DOCKERFILE");
    expect(railway.build.dockerfilePath).toBe("Dockerfile");
    expect(railway.deploy.healthcheckPath).toBe("/health");
    expect(railway.deploy.healthcheckTimeout).toBeGreaterThanOrEqual(300);
    expect(railway.deploy.numReplicas).toBe(1);
    expect(railway.deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(railway.deploy.restartPolicyMaxRetries).toBeGreaterThanOrEqual(10);
  });

  test("container is pinned, uses a restricted app user, and exposes the persistent data path", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toMatch(/^FROM oven\/bun:1\.3\.\d+-slim/m);
    expect(dockerfile).toContain("DATABASE_PATH=/app/data/postman2api.db");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain("ENTRYPOINT [\"/app/scripts/docker-entrypoint.sh\"]");
    expect(await read("scripts/docker-entrypoint.sh")).toContain("exec su -s /bin/sh bun");
  });

  test("bun user resolves the Camoufox cache directory at runtime", async () => {
    const dockerfile = await read("Dockerfile");
    const entrypoint = await read("scripts/docker-entrypoint.sh");
    const bridge = await read("src/auth/bridge.ts");

    // Camoufox is fetched at build time into /home/bun/.cache/camoufox and
    // must be resolvable by the bun user at runtime, otherwise the login
    // script falls back to detectable Chromium.
    expect(dockerfile).toContain("HOME=/home/bun");
    expect(dockerfile).toContain("XDG_CACHE_HOME=/home/bun/.cache");
    expect(entrypoint).toContain("export HOME=/home/bun");
    expect(entrypoint).toContain("export XDG_CACHE_HOME=/home/bun/.cache");
    expect(bridge).toContain("XDG_CACHE_HOME: \"/home/bun/.cache\"");
  });

  test("runtime image includes the Playwright Chromium and Camoufox browsers", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
    expect(dockerfile).toContain("python -m playwright install --with-deps chromium");
    expect(dockerfile).toContain("python -m camoufox fetch");
    expect(dockerfile).toContain("xvfb");
    expect(dockerfile).toContain("chown -R bun:bun /ms-playwright");
  });

  test("browser login attempts supplied credentials without logging the password", async () => {
    const script = await read("scripts/auth/postman_login.py");
    const bridge = await read("src/auth/bridge.ts");

    expect(script).toContain("input[type=\"email\"]");
    expect(script).toContain("input[type=\"password\"]");
    expect(script).toContain("await username_input.fill(email)");
    expect(script).toContain("await password_input.fill(password)");
    expect(script).toContain("raw = sys.stdin.read()");
    expect(script).toContain("sys.stdin.isatty()");
    expect(script).not.toContain("Password (ignored for manual login)");
    expect(bridge).not.toContain('"--password", password');
    expect(bridge).not.toContain("POSTMAN_LOGIN_PASSWORD: password");
    expect(bridge).toContain('stdin: "pipe"');
  });

  test("headless browser login fails clearly and cannot retain a process indefinitely", async () => {
    const script = await read("scripts/auth/postman_login.py");
    const bridge = await read("src/auth/bridge.ts");

    expect(script).toContain("Invalid Postman email/username or password.");
    expect(script).toContain("Postman requires multi-factor authentication");
    expect(script).toContain("Postman requires CAPTCHA/Turnstile verification");
    expect(script).toContain("Postman redirected to SSO/OAuth");
    expect(script).toContain("Cloudflare challenge that did not resolve");
    expect(script).toContain("reset email");
    expect(script).toContain("time.monotonic()");
    expect(bridge).toContain("LOGIN_PROCESS_TIMEOUT_MS");
    expect(bridge).toContain("proc.kill()");
    expect(bridge).toContain("Login process timed out");
  });

  test("deployment templates never ship usable default secrets", async () => {
    const files = await Promise.all([
      read(".env.example"),
      read("docker-compose.yml"),
      read("Dockerfile"),
    ]);
    const combined = files.join("\n");

    expect(combined).not.toContain("postman2api-secret-key");
    expect(combined).not.toContain("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(await read(".env.example")).toContain("ADMIN_KEY=");
  });

  test("Railway documentation requires a volume and rejects Redis as unnecessary", async () => {
    const docs = await read("docs/RAILWAY.md");

    expect(docs).toContain("/app/data");
    expect(docs).toMatch(/Redis.*不需要|不需要.*Redis/i);
    expect(docs).toContain("REQUIRE_PERSISTENT_STORAGE=true");
  });

  test("generated artifacts and runtime databases are ignored", async () => {
    const ignore = await read(".gitignore");

    expect(ignore).toContain("dashboard/node_modules/");
    expect(ignore).toContain("dashboard/dist/");
    expect(ignore).toContain("data/*.db-wal");
  });
});
