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

  test("container is pinned, non-root, and exposes the persistent data path", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile).toMatch(/^FROM oven\/bun:1\.3\.\d+-slim/m);
    expect(dockerfile).toContain("DATABASE_PATH=/app/data/postman2api.db");
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain('["bun", "src/index.ts"]');
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
