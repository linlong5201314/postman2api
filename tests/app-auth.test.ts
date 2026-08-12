import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const apiKey = "test-api-key-with-enough-entropy";
const adminKey = "test-admin-key-with-enough-entropy";
const runtimeConfig = loadConfig({ API_KEY: apiKey, ADMIN_KEY: adminKey });
const app = createApp({
  runtimeConfig,
  dashboardRoot: path.join(import.meta.dir, "dashboard-does-not-exist"),
  env: {},
});

describe("application authentication", () => {
  test("requires an API key on v1 routes", async () => {
    expect((await app.request("/v1/models")).status).toBe(401);
    expect((await app.request("/v1/models", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("accepts bearer and x-api-key authentication", async () => {
    expect((await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).status).toBe(200);
    expect((await app.request("/v1/models", {
      headers: { "x-api-key": apiKey },
    })).status).toBe(200);
  });

  test("requires the admin bearer key on api routes", async () => {
    expect((await app.request("/api/not-a-route")).status).toBe(401);
    expect((await app.request("/api/not-a-route", {
      headers: { Authorization: "Bearer wrong" },
    })).status).toBe(401);
    expect((await app.request("/api/not-a-route", {
      headers: { Authorization: `Bearer ${adminKey}` },
    })).status).not.toBe(401);
  });
});
