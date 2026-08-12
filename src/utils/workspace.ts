const WORKSPACE_SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(["go", "identity", "id", "www", "api", "god"]);

export function isValidWorkspaceSubdomain(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === value && WORKSPACE_SUBDOMAIN_RE.test(normalized) && !RESERVED.has(normalized);
}

export function normalizeWorkspaceSubdomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isValidWorkspaceSubdomain(normalized) ? normalized : null;
}
