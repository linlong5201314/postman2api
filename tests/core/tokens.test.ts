import { beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => {
  process.env.ENCRYPTION_KEY ||= "b".repeat(64);
});

describe("account tokens", () => {
  test("encrypts persisted token data and reads it back", async () => {
    const { decodeAccountTokens, encodeAccountTokens } = await import("../../src/auth/tokens");
    const tokens = {
      postman_sid: "session-secret",
      user_id: "user-1",
      workspace_id: "workspace-1",
      workspace_subdomain: "team-alpha",
    };
    const stored = encodeAccountTokens(tokens);
    expect(stored).toStartWith("enc:v1:");
    expect(stored).not.toContain("session-secret");
    expect(decodeAccountTokens(stored)).toEqual(tokens);
  });

  test("remains compatible with legacy plaintext JSON", async () => {
    const { decodeAccountTokens } = await import("../../src/auth/tokens");
    expect(decodeAccountTokens(JSON.stringify({
      postman_sid: "legacy-session",
      user_id: "user-1",
      workspace_id: "workspace-1",
      workspace_subdomain: "team-alpha",
    }))?.postman_sid).toBe("legacy-session");
  });

  test("rejects unsafe workspace subdomains", async () => {
    const { decodeAccountTokens } = await import("../../src/auth/tokens");
    expect(decodeAccountTokens(JSON.stringify({
      postman_sid: "session",
      user_id: "user-1",
      workspace_id: "workspace-1",
      workspace_subdomain: "evil.postman.co",
    }))).toBeNull();
  });
});
