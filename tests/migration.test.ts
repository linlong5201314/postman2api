import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const tempRoot = mkdtempSync(path.join(tmpdir(), "postman2api-migration-"));
const databasePath = path.join(tempRoot, "legacy.db");
const encryptionKey = "a".repeat(64);

async function migrate(): Promise<void> {
  const child = Bun.spawn([process.execPath, "src/db/migrate.ts"], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: databasePath, ENCRYPTION_KEY: encryptionKey },
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect(exitCode, stderr).toBe(0);
}

describe("database migrations", () => {
  beforeAll(() => {
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        enabled INTEGER NOT NULL DEFAULT 1,
        tokens TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        encrypted_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'unchecked',
        latency_ms INTEGER,
        last_checked_at INTEGER,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE UNIQUE INDEX proxies_host_port_idx ON proxies(host, port, protocol);
    `);
    legacy.query("INSERT INTO accounts (email, password, tokens, created_at) VALUES (?, ?, ?, ?)")
      .run("legacy@example.com", "encrypted-password", JSON.stringify({ postman_sid: "legacy-session" }), Date.now());
    legacy.query("INSERT INTO proxies (name, protocol, host, port, encrypted_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy", "http", "127.0.0.1", 8080, "opaque-legacy-value", Date.now());
    legacy.close();
  });

  afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

  test("upgrades legacy tables and is idempotent", async () => {
    await migrate();
    const migrated = new Database(databasePath);
    const accountColumns = migrated.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
    const proxyColumns = migrated.query("PRAGMA table_info(proxies)").all() as Array<{ name: string }>;
    const firstToken = migrated.query("SELECT tokens FROM accounts WHERE email = ?").get("legacy@example.com") as { tokens: string };
    const proxy = migrated.query("SELECT fingerprint, status FROM proxies WHERE id = 1").get() as {
      fingerprint: string;
      status: string;
    };

    expect(accountColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "proxy_id",
      "quota_limit",
      "quota_remaining",
      "quota_reset_at",
      "last_used_at",
      "last_login_at",
      "error_message",
      "metadata",
      "updated_at",
    ]));
    expect(proxyColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "encrypted_credentials",
      "fingerprint",
      "last_test_at",
      "last_error",
      "metadata",
    ]));
    expect(firstToken.tokens.startsWith("enc:v1:")).toBe(true);
    expect(proxy.fingerprint).toHaveLength(64);
    expect(proxy.status).toBe("untested");
    const nameColumn = proxyColumns.find((column) => column.name === "name") as { notnull: number } | undefined;
    expect(nameColumn?.notnull).toBe(0);
    expect(() => migrated.query(
      "INSERT INTO proxies (protocol, host, port, encrypted_url, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("http", "127.0.0.2", 8081, "opaque-new-value", "b".repeat(64), Date.now())).not.toThrow();
    migrated.close();

    await migrate();
    const rerun = new Database(databasePath);
    const secondToken = rerun.query("SELECT tokens FROM accounts WHERE email = ?").get("legacy@example.com") as { tokens: string };
    expect(secondToken.tokens).toBe(firstToken.tokens);
    rerun.close();
  });
});
