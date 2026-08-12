import { Hono } from "hono";
import { config } from "../config";

export const settingsRouter = new Hono();

settingsRouter.get("/", (c) => c.json({
  data: {
    apiKeyConfigured: Boolean(config.apiKey),
    adminKeyConfigured: Boolean(config.adminKey),
    browserLoginEnabled: config.enableBrowserLogin,
    persistentStorageRequired: config.requirePersistentStorage,
    proxyBootstrapConfigured: Boolean(config.proxyBootstrap || config.proxyBootstrapFile),
    warmupEnabled: config.warmupEnabled,
  },
}));

settingsRouter.put("/", (c) => c.json({
  error: "Runtime settings are read-only. Update environment variables and restart the service.",
}, 405));
