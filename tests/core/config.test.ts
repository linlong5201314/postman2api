import { describe, expect, test } from "bun:test";
import { loadConfig, validateRuntimeConfig } from "../../src/config";

describe("runtime configuration", () => {
  test("rejects missing production secrets", () => {
    const candidate = loadConfig({ NODE_ENV: "production" });
    expect(validateRuntimeConfig(candidate, { NODE_ENV: "production" })).toContain(
      "ADMIN_KEY must be set to at least 24 characters in production",
    );
    expect(validateRuntimeConfig(candidate, { NODE_ENV: "production" })).toContain(
      "API_KEY must be set to at least 24 characters in production",
    );
  });

  test("accepts strong production secrets", () => {
    const env = {
      NODE_ENV: "production",
      ADMIN_KEY: "admin-key-with-at-least-24-chars",
      API_KEY: "api-key-with-at-least-24-chars--",
      ENCRYPTION_KEY: "a".repeat(64),
      DATABASE_PATH: "data/test.db",
    };
    expect(validateRuntimeConfig(loadConfig(env), env)).toEqual([]);
  });

  test("does not hide an invalid configured port behind the default", () => {
    for (const value of ["70000", "not-a-port"]) {
      const env = { PORT: value };
      expect(validateRuntimeConfig(loadConfig(env), env)).toContain("PORT must be a valid TCP port");
    }
  });

  test("requires an explicit database path when persistent storage is mandatory", () => {
    const env = {
      NODE_ENV: "production",
      ADMIN_KEY: "admin-key-with-at-least-24-chars",
      API_KEY: "api-key-with-at-least-24-chars--",
      ENCRYPTION_KEY: "a".repeat(64),
      REQUIRE_PERSISTENT_STORAGE: "true",
    };
    expect(validateRuntimeConfig(loadConfig(env), env)).toContain(
      "DATABASE_PATH must be set when persistent storage is required",
    );
  });
});
