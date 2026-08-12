import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, client } from "./index";
import { decrypt, decryptJson, encryptJson, isEncryptedValue } from "../utils/crypto";
import { parseProxyLine } from "../proxies/parser";
import { config } from "../config";

type SqliteColumn = {
  name: string;
  notnull: number;
};

async function tableColumns(table: string): Promise<SqliteColumn[]> {
  return db.all<SqliteColumn>(sql.raw(`PRAGMA table_info(${table})`));
}

async function columns(table: string): Promise<Set<string>> {
  const rows = await tableColumns(table);
  return new Set(rows.map((row) => row.name));
}

async function addColumn(table: string, name: string, definition: string, existing: Set<string>): Promise<void> {
  if (existing.has(name)) return;
  await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`));
  existing.add(name);
}

function proxyFingerprint(row: {
  id: number;
  protocol: string;
  host: string;
  port: number;
  encryptedUrl: string;
}): string {
  for (const decode of [
    () => decryptJson<string>(row.encryptedUrl),
    () => decrypt(row.encryptedUrl),
  ]) {
    try {
      const parsed = parseProxyLine(decode());
      if (!("error" in parsed)) return parsed.fingerprint;
    } catch {
      // Fall through to a stable value that still lets an old row migrate.
    }
  }
  return createHash("sha256")
    .update(`${row.protocol.toLowerCase()}://${row.host.toLowerCase()}:${row.port}:${row.encryptedUrl}:${row.id}`)
    .digest("hex");
}

async function rebuildLegacyProxyTableIfNeeded(): Promise<void> {
  const definitions = await tableColumns("proxies");
  const byName = new Map(definitions.map((column) => [column.name, column]));
  const isLegacy = byName.get("name")?.notnull === 1
    || byName.get("fingerprint")?.notnull !== 1
    || byName.has("last_checked_at")
    || byName.has("error_message");
  if (!isLegacy) return;

  await db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    await db.run(sql`DROP TABLE IF EXISTS proxies__canonical_migration`);
    await db.run(sql`CREATE TABLE proxies__canonical_migration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      protocol TEXT NOT NULL DEFAULT 'http',
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      encrypted_url TEXT NOT NULL,
      encrypted_credentials TEXT,
      fingerprint TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'untested',
      latency_ms INTEGER,
      last_test_at INTEGER,
      last_error TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )`);
    await db.run(sql`INSERT INTO proxies__canonical_migration (
      id, name, protocol, host, port, encrypted_url, encrypted_credentials, fingerprint,
      enabled, status, latency_ms, last_test_at, last_error, metadata, created_at, updated_at
    ) SELECT
      id, name, protocol, host, port, encrypted_url, encrypted_credentials, fingerprint,
      enabled, status, latency_ms, last_test_at, last_error, metadata, created_at, updated_at
    FROM proxies`);
    await db.run(sql`DROP TABLE proxies`);
    await db.run(sql`ALTER TABLE proxies__canonical_migration RENAME TO proxies`);
  } finally {
    await db.run(sql`PRAGMA foreign_keys = ON`);
  }
}

async function migrateProxies(): Promise<void> {
  await db.run(sql`CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    protocol TEXT NOT NULL DEFAULT 'http',
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    encrypted_url TEXT NOT NULL,
    encrypted_credentials TEXT,
    fingerprint TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'untested',
    latency_ms INTEGER,
    last_test_at INTEGER,
    last_error TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  )`);

  const existing = await columns("proxies");
  await addColumn("proxies", "name", "TEXT", existing);
  await addColumn("proxies", "encrypted_credentials", "TEXT", existing);
  await addColumn("proxies", "fingerprint", "TEXT", existing);
  await addColumn("proxies", "last_test_at", "INTEGER", existing);
  await addColumn("proxies", "last_error", "TEXT", existing);
  await addColumn("proxies", "metadata", "TEXT", existing);
  await addColumn("proxies", "status", "TEXT NOT NULL DEFAULT 'untested'", existing);
  await addColumn("proxies", "latency_ms", "INTEGER", existing);
  await addColumn("proxies", "enabled", "INTEGER NOT NULL DEFAULT 1", existing);
  await addColumn("proxies", "created_at", "INTEGER NOT NULL DEFAULT 0", existing);
  await addColumn("proxies", "updated_at", "INTEGER", existing);

  if (existing.has("last_checked_at")) {
    await db.run(sql`UPDATE proxies SET last_test_at = COALESCE(last_test_at, last_checked_at) WHERE last_checked_at IS NOT NULL`);
  }
  if (existing.has("error_message")) {
    await db.run(sql`UPDATE proxies SET last_error = COALESCE(last_error, error_message) WHERE error_message IS NOT NULL`);
  }
  await db.run(sql`UPDATE proxies SET created_at = ${Date.now()} WHERE created_at IS NULL OR created_at = 0`);

  const rows = await db.all<{
    id: number;
    protocol: string;
    host: string;
    port: number;
    encryptedUrl: string;
    fingerprint: string | null;
  }>(
    sql`SELECT id, protocol, host, port, encrypted_url AS encryptedUrl, fingerprint FROM proxies`,
  );
  for (const row of rows) {
    if (!row.fingerprint) {
      await db.run(sql`UPDATE proxies SET fingerprint = ${proxyFingerprint(row)} WHERE id = ${row.id}`);
    }
  }
  await db.run(sql`UPDATE proxies SET status = 'untested' WHERE status = 'unchecked'`);
  await rebuildLegacyProxyTableIfNeeded();
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS proxies_fingerprint_idx ON proxies(fingerprint)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS proxies_enabled_idx ON proxies(enabled)`);
}

async function migrateAccounts(): Promise<void> {
  await db.run(sql`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    enabled INTEGER NOT NULL DEFAULT 1,
    proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
    tokens TEXT,
    quota_limit REAL DEFAULT 0,
    quota_remaining REAL DEFAULT 0,
    quota_reset_at INTEGER,
    last_used_at INTEGER,
    last_login_at INTEGER,
    error_message TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  )`);

  const existing = await columns("accounts");
  await addColumn("accounts", "status", "TEXT NOT NULL DEFAULT 'pending'", existing);
  await addColumn("accounts", "enabled", "INTEGER NOT NULL DEFAULT 1", existing);
  await addColumn("accounts", "proxy_id", "INTEGER REFERENCES proxies(id) ON DELETE SET NULL", existing);
  await addColumn("accounts", "tokens", "TEXT", existing);
  await addColumn("accounts", "quota_limit", "REAL DEFAULT 0", existing);
  await addColumn("accounts", "quota_remaining", "REAL DEFAULT 0", existing);
  await addColumn("accounts", "quota_reset_at", "INTEGER", existing);
  await addColumn("accounts", "last_used_at", "INTEGER", existing);
  await addColumn("accounts", "last_login_at", "INTEGER", existing);
  await addColumn("accounts", "error_message", "TEXT", existing);
  await addColumn("accounts", "metadata", "TEXT", existing);
  await addColumn("accounts", "created_at", "INTEGER NOT NULL DEFAULT 0", existing);
  await addColumn("accounts", "updated_at", "INTEGER", existing);
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_idx ON accounts(email)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS accounts_proxy_idx ON accounts(proxy_id)`);

  if (existing.has("tokens")) {
    const rows = await db.all<{ id: number; tokens: string | null }>(sql`SELECT id, tokens FROM accounts WHERE tokens IS NOT NULL`);
    const hasLegacyTokens = rows.some((row) => row.tokens && !isEncryptedValue(row.tokens));
    if (hasLegacyTokens && !config.encryptionKey) {
      throw new Error("ENCRYPTION_KEY is required to migrate legacy account tokens");
    }
    for (const row of rows) {
      if (!row.tokens || isEncryptedValue(row.tokens)) continue;
      try {
        const parsed = JSON.parse(row.tokens);
        await db.run(sql`UPDATE accounts SET tokens = ${encryptJson(parsed)} WHERE id = ${row.id}`);
      } catch {
        // Leave malformed legacy values untouched so operators can repair them explicitly.
      }
    }
  }
}

export async function runMigrations(): Promise<void> {
  console.log("[migrate] Creating tables...");
  await migrateProxies();
  await migrateAccounts();

  await db.run(sql`CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES accounts(id),
    model TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  )`);
  await db.run(sql`DELETE FROM settings WHERE lower(key) IN ('api_key', 'admin_key')`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs(created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_status_created_at_idx ON request_logs(status, created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_account_idx ON request_logs(account_id)`);
  console.log("[migrate] Done. Tables ready: accounts, request_logs, settings, proxies");
}

if (import.meta.main) {
  runMigrations()
    .catch((err) => {
      console.error("[migrate] Error:", err);
      process.exitCode = 1;
    })
    .finally(() => client.close());
}
