import type { PostmanTokens } from "../provider/transcript";
import { decryptJson, encryptJson } from "../utils/crypto";
import { normalizeWorkspaceSubdomain } from "../utils/workspace";

export function encodeAccountTokens(tokens: PostmanTokens): string {
  const normalized = normalizeTokens(tokens);
  if (!normalized) throw new Error("Invalid Postman token data");
  return encryptJson(normalized);
}

export function decodeAccountTokens(value: unknown): PostmanTokens | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return normalizeTokens(decryptJson<unknown>(value));
  } catch {
    return null;
  }
}

export function normalizeTokens(value: unknown): PostmanTokens | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const workspaceSubdomain = normalizeWorkspaceSubdomain(candidate.workspace_subdomain);
  if (
    typeof candidate.postman_sid !== "string" || !candidate.postman_sid.trim() ||
    typeof candidate.user_id !== "string" || !candidate.user_id.trim() ||
    typeof candidate.workspace_id !== "string" || !candidate.workspace_id.trim() ||
    !workspaceSubdomain
  ) {
    return null;
  }

  return {
    postman_sid: candidate.postman_sid,
    user_id: candidate.user_id,
    workspace_id: candidate.workspace_id,
    workspace_subdomain: workspaceSubdomain,
    user_name: typeof candidate.user_name === "string" ? candidate.user_name : undefined,
  };
}
