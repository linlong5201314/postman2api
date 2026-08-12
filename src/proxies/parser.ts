import { createHash } from "node:crypto";

export type ProxyProtocol = "http" | "https";

export interface ParsedProxy {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  url: string;
  fingerprint: string;
}

export interface ProxyParseError {
  line: string;
  reason: string;
}

export interface ProxyParseResult {
  proxies: ParsedProxy[];
  duplicates: number;
  errors: ProxyParseError[];
}

const SUPPORTED_PROTOCOLS = new Set(["http", "https"]);
const REJECTED_PROTOCOLS = new Set(["socks", "socks4", "socks4a", "socks5", "socks5h"]);

export function parseProxyBatch(input: string): ProxyParseResult {
  const proxies: ParsedProxy[] = [];
  const errors: ProxyParseError[] = [];
  const seen = new Set<string>();
  let defaultProtocol: ProxyProtocol = "http";
  let duplicates = 0;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const title = parseProtocolTitle(line);
    if (title) {
      defaultProtocol = title;
      continue;
    }

    const parsed = parseProxyLine(line, defaultProtocol);
    if ("error" in parsed) {
      errors.push({ line, reason: parsed.error });
      continue;
    }

    if (seen.has(parsed.fingerprint)) {
      duplicates++;
      continue;
    }
    seen.add(parsed.fingerprint);
    proxies.push(parsed);
  }

  return { proxies, duplicates, errors };
}

export function parseProxyLine(input: string, defaultProtocol: ProxyProtocol = "http"): ParsedProxy | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Empty proxy line" };

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const protocol = schemeMatch[1]!.toLowerCase();
    if (REJECTED_PROTOCOLS.has(protocol)) return { error: "SOCKS proxies are not supported by Bun fetch proxy" };
    if (!SUPPORTED_PROTOCOLS.has(protocol)) return { error: `Unsupported proxy protocol: ${protocol}` };
    return parseUrlProxy(trimmed, protocol as ProxyProtocol);
  }

  if (trimmed.includes("@")) {
    return parseUserInfoProxy(trimmed, defaultProtocol);
  }

  const parts = trimmed.split(":");
  if (parts.length === 2) {
    return buildParsedProxy(defaultProtocol, parts[0]!, parts[1]!);
  }
  if (parts.length === 4) {
    return buildParsedProxy(defaultProtocol, parts[0]!, parts[1]!, parts[2], parts[3]);
  }

  return { error: "Expected host:port, host:port:user:pass, user:pass@host:port, or URL format" };
}

export function maskProxyUrl(proxy: Pick<ParsedProxy, "protocol" | "host" | "port" | "username">): string {
  const auth = proxy.username ? `${maskSecret(proxy.username)}:***@` : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

export function sanitizeProxyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(https?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, "$1***:***@")
    .replace(/\b([^:\s/@]+):([^@\s]+)@([a-z0-9.-]+:\d+)/gi, "***:***@$3");
}

function parseProtocolTitle(line: string): ProxyProtocol | null {
  const normalized = line.toLowerCase().replace(/:$/, "").replace(/\/\/$/, "");
  return normalized === "http" || normalized === "https" ? normalized : null;
}

function parseUrlProxy(input: string, protocol: ProxyProtocol): ParsedProxy | { error: string } {
  try {
    const url = new URL(input);
    return buildParsedProxy(protocol, url.hostname, url.port, url.username || undefined, url.password || undefined);
  } catch {
    return { error: "Invalid proxy URL" };
  }
}

function parseUserInfoProxy(input: string, protocol: ProxyProtocol): ParsedProxy | { error: string } {
  const [auth, address, ...rest] = input.split("@");
  if (!auth || !address || rest.length > 0) return { error: "Invalid proxy auth format" };
  const [username, password, ...authRest] = auth.split(":");
  if (!username || password === undefined || authRest.length > 0) return { error: "Expected user:pass@host:port" };
  const [host, port, ...addressRest] = address.split(":");
  if (!host || !port || addressRest.length > 0) return { error: "Expected user:pass@host:port" };
  return buildParsedProxy(protocol, host, port, username, password);
}

function buildParsedProxy(
  protocol: ProxyProtocol,
  rawHost: string,
  rawPort: string,
  username?: string,
  password?: string,
): ParsedProxy | { error: string } {
  const host = rawHost.trim();
  const port = Number(rawPort);
  if (!host) return { error: "Missing proxy host" };
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: "Invalid proxy port" };
  const normalizedUsername = username?.trim();
  const normalizedPassword = password?.trim();
  const auth = normalizedUsername
    ? `${encodeURIComponent(normalizedUsername)}:${encodeURIComponent(normalizedPassword || "")}@`
    : "";
  const url = `${protocol}://${auth}${host}:${port}`;
  const fingerprint = createHash("sha256")
    .update(`${protocol}://${normalizedUsername || ""}:${normalizedPassword || ""}@${host.toLowerCase()}:${port}`)
    .digest("hex");
  return {
    protocol,
    host,
    port,
    username: normalizedUsername || undefined,
    password: normalizedUsername ? normalizedPassword || "" : undefined,
    url,
    fingerprint,
  };
}

function maskSecret(value: string): string {
  if (value.length <= 2) return "*".repeat(value.length || 1);
  return `${value[0]}${"*".repeat(Math.min(6, value.length - 2))}${value[value.length - 1]}`;
}
