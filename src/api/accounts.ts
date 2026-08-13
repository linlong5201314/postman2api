import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs } from "../db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../utils/crypto";
import { decodeAccountTokens, encodeAccountTokens } from "../auth/tokens";
import { completeTokensViaHandshake, type ManualTokensInput } from "../auth/handshake";
import { normalizeWorkspaceSubdomain } from "../utils/workspace";
import { loginPostmanAccount } from "../auth/bridge";
import { warmupAccount } from "../auth/warmup";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { publicError } from "../utils/redact";

export const accountsRouter = new Hono();

// List all accounts
accountsRouter.get("/", async (c) => {
  const allAccounts = await db.select().from(accounts);
  const sanitized = allAccounts.map((acc) => {
    const tokens = decodeAccountTokens(acc.tokens);
    return {
      id: acc.id,
      email: acc.email,
      status: acc.status,
      enabled: acc.enabled,
      quotaLimit: acc.quotaLimit,
      quotaRemaining: acc.quotaRemaining,
      lastUsedAt: acc.lastUsedAt,
      lastLoginAt: acc.lastLoginAt,
      errorMessage: acc.errorMessage,
      hasTokens: !!(tokens?.postman_sid),
      proxyId: acc.proxyId,
      workspaceSubdomain: tokens?.workspace_subdomain || null,
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
    };
  });
  return c.json({ data: sanitized });
});

// Add account via browser login
accountsRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string; headless?: boolean; proxy?: string };
  if (!body.email || !body.password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const proxy = typeof body.proxy === "string" && body.proxy.trim() ? body.proxy.trim() : undefined;
  if (proxy !== undefined) {
    const normalized = proxy.includes("://") ? proxy : `http://${proxy}`;
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      return c.json({ error: "Proxy must be a valid http(s) URL" }, 400);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return c.json({ error: "Proxy must be a valid http(s) URL" }, 400);
    }
  }

  const headless = body.headless ?? false;
  broadcast({ type: "login_start", data: { email: body.email, headless } });

  const result = await loginPostmanAccount(body.email, body.password, headless, proxy);
  if (!result.success) {
    return c.json({ error: publicError(result.error, "Login failed"), logs: result.logs || [] }, 400);
  }

  return c.json({ success: true, accountId: result.accountId });
});

// Add account via manual token paste
accountsRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    email?: string;
    tokens?: ManualTokensInput;
  };

  if (!body.email || !body.tokens?.postman_sid || !normalizeWorkspaceSubdomain(body.tokens.workspace_subdomain)) {
    return c.json({
      error: "Email and tokens (postman_sid, workspace_subdomain) required; user_id/workspace_id are filled in automatically",
    }, 400);
  }

  const tokens = await completeTokensViaHandshake(body.tokens);
  if (!tokens) {
    return c.json({ error: "Invalid or expired postman.sid; log in again and copy a fresh session" }, 400);
  }

  const [existing] = await db.select().from(accounts).where(eq(accounts.email, body.email)).limit(1);

  if (existing) {
    const [updated] = await db.update(accounts)
      .set({
          tokens: encodeAccountTokens(tokens),
        status: "active",
        lastLoginAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(accounts.id, existing.id))
      .returning();
    broadcast({ type: "account_updated", data: { id: updated!.id, status: "active" } });
    return c.json({ success: true, account: { id: updated!.id, email: updated!.email } });
  }

  const [created] = await db.insert(accounts).values({
    email: body.email,
    password: encrypt("manual"),
    tokens: encodeAccountTokens(tokens),
    status: "active",
    lastLoginAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();

  broadcast({ type: "account_added", data: { id: created!.id, email: created!.email, status: "active" } });
  return c.json({ success: true, account: { id: created!.id, email: created!.email } });
});

// Delete account
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Nullify FK references in request_logs before deleting
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
  await db.delete(accounts).where(eq(accounts.id, id));
  pool.invalidate();
  broadcast({ type: "account_deleted", data: { id } });
  return c.json({ success: true });
});

// Warmup / health check single account
accountsRouter.post("/:id/warmup", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await warmupAccount(id);
  return c.json(result, result.success ? 200 : 400);
});

// Toggle enabled
accountsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  if (body.enabled === undefined) {
    return c.json({ error: "Missing 'enabled' field" }, 400);
  }
  const account = await pool.setEnabled(id, body.enabled);
  return c.json({ success: true, account: { id: account?.id, enabled: account?.enabled } });
});
