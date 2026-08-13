import { describe, expect, test, beforeEach } from "bun:test";
import { completeTokensViaHandshake } from "../src/auth/handshake";

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.sig`;
}

describe("manual token completion", () => {
  beforeEach(() => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const cookie = init?.headers?.Cookie ?? init?.headers?.get?.("Cookie") ?? "";
      if (url.includes("handshake/token")) {
        if (!cookie.includes("postman.sid=valid")) {
          return new Response(JSON.stringify({ error: { message: "User is not authenticated" } }), { status: 403 });
        }
        return new Response(JSON.stringify({ token: jwt({ userId: "u-123", teamId: "w-456" }) }));
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  });

  test("fills missing user_id and workspace_id from the handshake endpoint", async () => {
    const tokens = await completeTokensViaHandshake({
      postman_sid: "valid",
      workspace_subdomain: "linlongli-2423114",
    });

    expect(tokens).not.toBeNull();
    expect(tokens!.user_id).toBe("u-123");
    expect(tokens!.workspace_id).toBe("w-456");
    expect(tokens!.workspace_subdomain).toBe("linlongli-2423114");
  });

  test("keeps supplied ids without calling the network", async () => {
    const tokens = await completeTokensViaHandshake({
      postman_sid: "valid",
      user_id: "given-user",
      workspace_id: "given-workspace",
      workspace_subdomain: "linlongli-2423114",
    });

    expect(tokens).not.toBeNull();
    expect(tokens!.user_id).toBe("given-user");
    expect(tokens!.workspace_id).toBe("given-workspace");
  });

  test("rejects expired sessions", async () => {
    const tokens = await completeTokensViaHandshake({
      postman_sid: "expired",
      workspace_subdomain: "linlongli-2423114",
    });

    expect(tokens).toBeNull();
  });

  test("rejects unsafe workspace subdomains", async () => {
    const tokens = await completeTokensViaHandshake({
      postman_sid: "valid",
      workspace_subdomain: "go",
    });

    expect(tokens).toBeNull();
  });
});
