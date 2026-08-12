import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const adminKey = "settings-admin-key-with-enough-entropy";
const apiKey = "settings-api-key-with-enough-entropy";
const app = createApp({
  runtimeConfig: loadConfig({ ADMIN_KEY: adminKey, API_KEY: apiKey }),
  dashboardRoot: path.join(import.meta.dir, "dashboard-does-not-exist"),
  env: {},
});

describe("settings security", () => {
  test("returns configuration state without returning secrets", async () => {
    const response = await app.request("/api/settings", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(adminKey);
    expect(text).not.toContain(apiKey);
    expect(JSON.parse(text).data.apiKeyConfigured).toBe(true);
  });

  test("does not allow API or admin keys to be changed through the database settings API", async () => {
    const response = await app.request("/api/settings", {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "replacement", admin_key: "replacement" }),
    });
    expect(response.status).toBe(405);
  });
});
