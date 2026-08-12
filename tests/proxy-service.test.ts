import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db/index";
import { accounts, proxies, requestLogs } from "../src/db/schema";
import { runMigrations } from "../src/db/migrate";
import {
  assignProxiesRoundRobin,
  getProxyForAccount,
  importProxies,
  listProxies,
  testProxy,
} from "../src/proxies/service";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const firstProxy = `http://alice:secret@127.0.0.1:${8100 + Math.floor(Math.random() * 100)}`;
const secondProxy = `127.0.0.2:${8200 + Math.floor(Math.random() * 100)}`;
const emails = [
  `proxy-test-a-${suffix}@example.com`,
  `proxy-test-b-${suffix}@example.com`,
  `proxy-test-c-${suffix}@example.com`,
];

describe.serial("proxy service", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  test("encrypts imported URLs, masks credentials, and deduplicates", async () => {
    const result = await importProxies([
      firstProxy,
      firstProxy,
      "socks5://127.0.0.1:1080",
    ].join("\n"));
    const [stored] = await db.select().from(proxies);
    const [listed] = await listProxies();

    expect(result.created).toHaveLength(1);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(stored?.encryptedUrl).toStartWith("enc:v1:");
    expect(stored?.encryptedUrl).not.toContain("secret");
    expect(listed?.maskedUrl).not.toContain("secret");
    expect(listed?.hasCredentials).toBe(true);
  });

  test("tests the proxy through Bun fetch's proxy option", async () => {
    await importProxies(firstProxy);
    const [stored] = await db.select().from(proxies);
    let observedProxy: unknown;
    const result = await testProxy(stored!.id, async (_url, init) => {
      observedProxy = init?.proxy;
      return new Response("ok");
    });
    expect(result.success).toBe(true);
    expect(observedProxy).toBe(firstProxy);
  });

  test("assigns enabled proxies to accounts in stable round-robin order", async () => {
    await importProxies(firstProxy);
    await importProxies(secondProxy);
    await db.insert(accounts).values([
      { email: emails[0]!, password: "x", status: "active", createdAt: new Date() },
      { email: emails[1]!, password: "x", status: "active", createdAt: new Date() },
      { email: emails[2]!, password: "x", status: "active", createdAt: new Date() },
    ]);
    expect((await assignProxiesRoundRobin()).assigned).toBe(3);
    const rows = await db.select().from(accounts);
    const proxyRows = await db.select().from(proxies);
    expect(rows.map((row) => row.proxyId)).toEqual([
      proxyRows[0]!.id,
      proxyRows[1]!.id,
      proxyRows[0]!.id,
    ]);
    expect(await getProxyForAccount(rows[0]!)).toBe(firstProxy);
  });

  test("does not delete unrelated runtime data", async () => {
    const [account] = await db.insert(accounts).values({
      email: `unrelated-${suffix}@example.com`, password: "x", status: "active", createdAt: new Date(),
    }).returning();
    await db.insert(requestLogs).values({ model: "unrelated", status: "success", createdAt: new Date() });
    expect(account?.email).toBe(`unrelated-${suffix}@example.com`);
    expect((await db.select().from(requestLogs)).some((row) => row.model === "unrelated")).toBe(true);
  });
});
