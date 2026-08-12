import { readFile } from "node:fs/promises";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, proxies, type Account, type NewProxy, type Proxy } from "../db/schema";
import { encryptJson, decryptJson } from "../utils/crypto";
import type { ProviderFetch, ProviderProxyOption } from "../provider/base";
import { config } from "../config";
import {
  maskProxyUrl,
  parseProxyBatch,
  type ParsedProxy,
  sanitizeProxyError,
} from "./parser";

export interface SanitizedProxy {
  id: number;
  name: string | null;
  protocol: "http" | "https";
  host: string;
  port: number;
  enabled: boolean;
  status: string;
  latencyMs: number | null;
  lastTestAt: Date | null;
  lastError: string | null;
  maskedUrl: string;
  hasCredentials: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface ImportProxyResult {
  created: SanitizedProxy[];
  duplicates: number;
  errors: { line: string; reason: string }[];
}

export interface ProxyTestResult {
  id: number;
  success: boolean;
  latencyMs?: number;
  error?: string;
}

let proxyRoundRobinIndex = -1;

export async function listProxies(): Promise<SanitizedProxy[]> {
  const rows = await db.select().from(proxies).orderBy(asc(proxies.id));
  return rows.map(sanitizeProxy);
}

export async function importProxies(text: string): Promise<ImportProxyResult> {
  const parsed = parseProxyBatch(text);
  if (parsed.proxies.length === 0) {
    return { created: [], duplicates: parsed.duplicates, errors: parsed.errors };
  }

  const existing = await db.select({ fingerprint: proxies.fingerprint })
    .from(proxies)
    .where(inArray(proxies.fingerprint, parsed.proxies.map((proxy) => proxy.fingerprint)));
  const existingFingerprints = new Set(existing.map((row) => row.fingerprint));

  const values: NewProxy[] = [];
  let duplicates = parsed.duplicates;
  for (const proxy of parsed.proxies) {
    if (existingFingerprints.has(proxy.fingerprint)) {
      duplicates++;
      continue;
    }
    values.push(proxyToInsert(proxy));
  }

  const created = values.length > 0 ? await db.insert(proxies).values(values).returning() : [];
  return { created: created.map(sanitizeProxy), duplicates, errors: parsed.errors };
}

export async function createProxy(url: string, name?: string): Promise<SanitizedProxy> {
  const result = await importProxies(url);
  if (result.created[0]) {
    if (name) {
      const [updated] = await db.update(proxies)
        .set({ name, updatedAt: new Date() })
        .where(eq(proxies.id, result.created[0].id))
        .returning();
      return sanitizeProxy(updated!);
    }
    return result.created[0];
  }
  const reason = result.errors[0]?.reason || "Proxy already exists";
  throw new Error(reason);
}

export async function setProxyEnabled(id: number, enabled: boolean): Promise<SanitizedProxy | null> {
  const [proxy] = await db.update(proxies)
    .set({ enabled, status: enabled ? "untested" : "disabled", updatedAt: new Date() })
    .where(eq(proxies.id, id))
    .returning();
  return proxy ? sanitizeProxy(proxy) : null;
}

export async function deleteProxy(id: number): Promise<void> {
  await db.update(accounts).set({ proxyId: null, updatedAt: new Date() }).where(eq(accounts.proxyId, id));
  await db.delete(proxies).where(eq(proxies.id, id));
}

export async function bindProxyToAccount(accountId: number, proxyId: number | null): Promise<Account | null> {
  if (proxyId !== null) {
    const [proxy] = await db.select().from(proxies).where(eq(proxies.id, proxyId)).limit(1);
    if (!proxy) throw new Error("Proxy not found");
  }

  const [account] = await db.update(accounts)
    .set({ proxyId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning();
  return account || null;
}

export async function getProxyForAccount(account: Account): Promise<ProviderProxyOption | undefined> {
  let proxy: Proxy | undefined;
  if (account.proxyId) {
    [proxy] = await db.select().from(proxies).where(
      and(eq(proxies.id, account.proxyId), eq(proxies.enabled, true)),
    ).limit(1);
  }

  if (!proxy) {
    proxy = await assignNextEnabledProxy(account.id);
  }

  return proxy ? decryptProxyUrl(proxy) : undefined;
}

export async function testProxy(id: number, fetchImpl: ProviderFetch = globalThis.fetch as ProviderFetch): Promise<ProxyTestResult> {
  const [proxy] = await db.select().from(proxies).where(eq(proxies.id, id)).limit(1);
  if (!proxy) return { id, success: false, error: "Proxy not found" };

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(config.proxyTestUrl, {
      method: "GET",
      proxy: decryptProxyUrl(proxy),
      signal: AbortSignal.timeout(config.proxyTestTimeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`Proxy test failed with HTTP ${response.status}`);
    await db.update(proxies)
      .set({ status: "healthy", latencyMs, lastTestAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(proxies.id, id));
    return { id, success: true, latencyMs };
  } catch (error) {
    const sanitized = sanitizeProxyError(error);
    await db.update(proxies)
      .set({ status: "error", latencyMs: null, lastTestAt: new Date(), lastError: sanitized, updatedAt: new Date() })
      .where(eq(proxies.id, id));
    return { id, success: false, error: sanitized };
  }
}

export async function testAllProxies(fetchImpl: ProviderFetch = globalThis.fetch as ProviderFetch): Promise<ProxyTestResult[]> {
  const rows = await db.select({ id: proxies.id }).from(proxies);
  return Promise.all(rows.map((row) => testProxy(row.id, fetchImpl)));
}

export async function assignProxiesRoundRobin(): Promise<{ assigned: number }> {
  const available = await db.select().from(proxies).where(eq(proxies.enabled, true)).orderBy(asc(proxies.id));
  if (available.length === 0) return { assigned: 0 };
  const allAccounts = await db.select().from(accounts).orderBy(asc(accounts.id));
  let assigned = 0;
  for (let i = 0; i < allAccounts.length; i++) {
    const account = allAccounts[i]!;
    const proxy = available[i % available.length]!;
    await db.update(accounts).set({ proxyId: proxy.id, updatedAt: new Date() }).where(eq(accounts.id, account.id));
    assigned++;
  }
  return { assigned };
}

export async function bootstrapProxiesFromEnv(): Promise<ImportProxyResult> {
  const parts: string[] = [];
  if (config.proxyBootstrap) parts.push(config.proxyBootstrap);
  if (config.proxyBootstrapFile) {
    try {
      parts.push(await readFile(config.proxyBootstrapFile, "utf8"));
    } catch (error) {
      return {
        created: [],
        duplicates: 0,
        errors: [{ line: config.proxyBootstrapFile, reason: sanitizeProxyError(error) }],
      };
    }
  }
  if (parts.length === 0) return { created: [], duplicates: 0, errors: [] };
  return importProxies(parts.join("\n"));
}

function proxyToInsert(proxy: ParsedProxy): NewProxy {
  const credentials = proxy.username
    ? { username: proxy.username, password: proxy.password || "" }
    : null;
  return {
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    encryptedUrl: encryptJson(proxy.url),
    encryptedCredentials: credentials ? encryptJson(credentials) : null,
    fingerprint: proxy.fingerprint,
    enabled: true,
    status: "untested",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function sanitizeProxy(proxy: Proxy): SanitizedProxy {
  const credentials = decryptCredentials(proxy);
  return {
    id: proxy.id,
    name: proxy.name,
    protocol: proxy.protocol as "http" | "https",
    host: proxy.host,
    port: proxy.port,
    enabled: proxy.enabled,
    status: proxy.status,
    latencyMs: proxy.latencyMs,
    lastTestAt: proxy.lastTestAt,
    lastError: proxy.lastError,
    maskedUrl: maskProxyUrl({
      protocol: proxy.protocol as "http" | "https",
      host: proxy.host,
      port: proxy.port,
      username: credentials?.username,
    }),
    hasCredentials: !!credentials?.username,
    createdAt: proxy.createdAt,
    updatedAt: proxy.updatedAt,
  };
}

function decryptCredentials(proxy: Proxy): { username: string; password: string } | null {
  if (!proxy.encryptedCredentials) return null;
  try {
    return decryptJson<{ username: string; password: string }>(proxy.encryptedCredentials);
  } catch {
    return null;
  }
}

function decryptProxyUrl(proxy: Proxy): string {
  return decryptJson<string>(proxy.encryptedUrl);
}

async function assignNextEnabledProxy(accountId: number): Promise<Proxy | undefined> {
  const enabled = await db.select().from(proxies).where(eq(proxies.enabled, true)).orderBy(asc(proxies.id));
  if (enabled.length === 0) return undefined;
  proxyRoundRobinIndex = (proxyRoundRobinIndex + 1) % enabled.length;
  const selected = enabled[proxyRoundRobinIndex]!;
  await db.update(accounts).set({ proxyId: selected.id, updatedAt: new Date() }).where(eq(accounts.id, accountId));
  return selected;
}
