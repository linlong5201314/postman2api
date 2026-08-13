import type { PostmanTokens } from "../provider/transcript";
import { normalizeTokens } from "./tokens";

const HANDSHAKE_URL = "https://ra.gw.postman.co/v1/handshake/token?agent=cloud";

export interface ManualTokensInput {
  postman_sid?: string;
  user_id?: string;
  workspace_id?: string;
  workspace_subdomain?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  const payload = parts[1]!;
  const padding = "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const decoded = Buffer.from(payload + padding, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function completeTokensViaHandshake(input: ManualTokensInput): Promise<PostmanTokens | null> {
  const sid = input.postman_sid?.trim() || "";
  if (!sid) return null;

  let userId = input.user_id?.trim() || "";
  let workspaceId = input.workspace_id?.trim() || "";

  if (!userId || !workspaceId) {
    try {
      const resp = await fetch(HANDSHAKE_URL, {
        headers: { Cookie: `postman.sid=${sid}` },
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { token?: unknown };
      if (!data?.token || typeof data.token !== "string") return null;
      const payload = decodeJwtPayload(data.token);
      if (!userId && typeof payload.userId === "string") userId = payload.userId;
      if (!workspaceId && typeof payload.teamId === "string") workspaceId = payload.teamId;
    } catch {
      return null;
    }
  }

  return normalizeTokens({
    postman_sid: sid,
    user_id: userId,
    workspace_id: workspaceId,
    workspace_subdomain: input.workspace_subdomain,
  });
}
