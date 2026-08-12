import path from "node:path";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { accountsRouter } from "./api/accounts";
import { chatRouter } from "./api/chat";
import { modelsRouter } from "./api/models";
import { proxiesRouter } from "./api/proxies";
import { statsRouter } from "./api/stats";
import { config, type Config } from "./config";
import { db } from "./db/index";
import { requestLogs } from "./db/schema";
import { redactSensitive } from "./utils/redact";
import { resolveStaticPath } from "./utils/static-files";
import { constantTimeEqual } from "./auth/admin";

export interface CreateAppOptions {
  runtimeConfig?: Config;
  dashboardRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const runtimeConfig = options.runtimeConfig ?? config;
  const env = options.env ?? process.env;
  const dashboardRoot = options.dashboardRoot ?? path.resolve(import.meta.dir, "..", "dashboard", "dist");
  const app = new Hono();

  app.get("/livez", (c) => c.json({ status: "ok", uptime: process.uptime() }));

  app.get("/health", async (c) => {
    const checks: Record<string, string> = {};
    try {
      await db.run(sql`CREATE TABLE IF NOT EXISTS healthcheck_probe (id INTEGER PRIMARY KEY, updated_at INTEGER NOT NULL)`);
      await db.run(sql`INSERT INTO healthcheck_probe (id, updated_at) VALUES (1, ${Date.now()}) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`);
      await db.select({ count: sql<number>`count(*)` }).from(requestLogs).limit(1);
      checks.database = "ok";
    } catch (error) {
      console.error("[health] Database check failed:", redactSensitive(error));
      checks.database = "unavailable";
      return c.json({ status: "error", checks }, 503);
    }

    if (runtimeConfig.requirePersistentStorage && env.RAILWAY_ENVIRONMENT && !env.RAILWAY_VOLUME_MOUNT_PATH) {
      checks.storage = "volume_not_mounted";
      return c.json({ status: "error", checks }, 503);
    }
    checks.storage = "ok";
    return c.json({ status: "ok", uptime: process.uptime(), checks });
  });

  app.use("/v1/*", async (c, next) => {
    const authorization = bearerToken(c.req.header("Authorization"));
    const apiKeyHeader = c.req.header("x-api-key");
    if (!constantTimeEqual(authorization, runtimeConfig.apiKey) && !constantTimeEqual(apiKeyHeader, runtimeConfig.apiKey)) {
      return c.json({ error: { message: "Invalid API key", type: "invalid_api_key" } }, 401);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    if (!constantTimeEqual(bearerToken(c.req.header("Authorization")), runtimeConfig.adminKey)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.route("/", chatRouter);
  app.route("/", modelsRouter);
  app.route("/api/accounts", accountsRouter);
  app.route("/api/stats", statsRouter);
  app.get("/api/settings", (c) => c.json({
    data: {
      apiKeyConfigured: Boolean(runtimeConfig.apiKey),
      adminKeyConfigured: Boolean(runtimeConfig.adminKey),
      browserLoginEnabled: runtimeConfig.enableBrowserLogin,
      persistentStorageRequired: runtimeConfig.requirePersistentStorage,
      proxyBootstrapConfigured: Boolean(runtimeConfig.proxyBootstrap || runtimeConfig.proxyBootstrapFile),
      warmupEnabled: runtimeConfig.warmupEnabled,
    },
  }));
  app.put("/api/settings", (c) => c.json({
    error: "Runtime settings are read-only. Update environment variables and restart the service.",
  }, 405));
  app.route("/api/proxies", proxiesRouter);

  app.get("*", async (c) => {
    let requestedFile: string | null;
    try {
      requestedFile = resolveStaticPath(dashboardRoot, c.req.path);
    } catch {
      return c.text("Not found", 404);
    }
    if (!requestedFile) return c.text("Not found", 404);

    const file = Bun.file(requestedFile);
    if (await file.exists()) return new Response(file);

    const indexPath = resolveStaticPath(dashboardRoot, "/index.html");
    if (indexPath) {
      const index = Bun.file(indexPath);
      if (await index.exists()) return new Response(index);
    }

    if (c.req.path === "/" || c.req.path === "/index.html") {
      return c.text("Dashboard not built. Run: cd dashboard && bun install && bun run build", 404);
    }
    return c.text("Not found", 404);
  });

  return app;
}

export const app = createApp();
