import { Hono } from "hono";
import {
  assignProxiesRoundRobin,
  bindProxyToAccount,
  createProxy,
  deleteProxy,
  importProxies,
  listProxies,
  setProxyEnabled,
  testAllProxies,
  testProxy,
} from "../proxies/service";

export const proxiesRouter = new Hono();

proxiesRouter.get("/", async (c) => {
  return c.json({ data: await listProxies() });
});

proxiesRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { url?: string; text?: string; name?: string };
  if (body.text) {
    return c.json({ success: true, ...(await importProxies(body.text)) });
  }
  if (!body.url) return c.json({ error: "Missing proxy url or text" }, 400);
  try {
    const proxy = await createProxy(body.url, body.name);
    return c.json({ success: true, proxy });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

proxiesRouter.post("/assign", async (c) => {
  return c.json({ success: true, ...(await assignProxiesRoundRobin()) });
});

proxiesRouter.post("/test-all", async (c) => {
  return c.json({ data: await testAllProxies() });
});

proxiesRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  if (body.enabled === undefined) return c.json({ error: "Missing enabled" }, 400);
  const proxy = await setProxyEnabled(id, body.enabled);
  if (!proxy) return c.json({ error: "Proxy not found" }, 404);
  return c.json({ success: true, proxy });
});

proxiesRouter.delete("/:id", async (c) => {
  await deleteProxy(Number(c.req.param("id")));
  return c.json({ success: true });
});

proxiesRouter.post("/:id/test", async (c) => {
  const result = await testProxy(Number(c.req.param("id")));
  return c.json(result, result.success ? 200 : 400);
});

proxiesRouter.post("/accounts/:accountId/bind", async (c) => {
  const accountId = Number(c.req.param("accountId"));
  const body = await c.req.json().catch(() => ({})) as { proxyId?: number | null };
  if (!("proxyId" in body)) return c.json({ error: "Missing proxyId" }, 400);
  try {
    const account = await bindProxyToAccount(accountId, body.proxyId ?? null);
    if (!account) return c.json({ error: "Account not found" }, 404);
    return c.json({ success: true, account: { id: account.id, proxyId: account.proxyId } });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
