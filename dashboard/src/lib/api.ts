const API_BASE = "";
const ADMIN_KEY_STORAGE = "postman2api.admin-key";

let onUnauthorized: (() => void) | undefined;

export function getAdminKey(): string {
  return sessionStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

export function setAdminKey(key: string): void {
  sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
}

export function clearAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
}

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const key = getAdminKey();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(options?.headers || {}),
    },
  });
  if (res.status === 401) {
    clearAdminKey();
    onUnauthorized?.();
  }
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: number;
  email: string;
  status: string;
  enabled: boolean;
  quotaLimit?: number | null;
  quotaRemaining?: number | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  hasTokens: boolean;
  workspaceSubdomain?: string | null;
  proxyId?: number | null;
  createdAt?: string;
}

export interface Proxy {
  id: number;
  name: string | null;
  protocol: "http" | "https";
  host: string;
  port: number;
  enabled: boolean;
  status: string;
  latencyMs: number | null;
  lastTestAt: string | null;
  lastError: string | null;
  maskedUrl: string;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface ImportProxiesResult {
  success: boolean;
  created: Proxy[];
  duplicates: number;
  errors: Array<{ line: string; reason: string }>;
}

export interface Stats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalAccounts: number;
  activeAccounts: number;
  recentRequests: any[];
}

export async function fetchAccounts(): Promise<{ data: Account[] }> {
  return api("/api/accounts");
}

export async function loginAccount(email: string, password: string, headless: boolean): Promise<{ success: boolean }> {
  return api("/api/accounts/login", {
    method: "POST",
    body: JSON.stringify({ email, password, headless }),
  });
}

export async function addAccountManual(email: string, tokens: any): Promise<{ success: boolean }> {
  return api("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email, tokens }),
  });
}

export async function deleteAccount(id: number): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function warmupAccount(id: number): Promise<{ success: boolean; error?: string }> {
  return api(`/api/accounts/${id}/warmup`, { method: "POST" });
}

export async function toggleAccount(id: number, enabled: boolean): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchStats(): Promise<{ data: Stats }> {
  return api("/api/stats");
}

export interface RuntimeSettings {
  apiKeyConfigured: boolean;
  adminKeyConfigured: boolean;
  browserLoginEnabled: boolean;
  persistentStorageRequired: boolean;
  proxyBootstrapConfigured: boolean;
  warmupEnabled: boolean;
}

export async function fetchSettings(): Promise<{ data: RuntimeSettings }> {
  return api("/api/settings");
}

export async function fetchProxies(): Promise<{ data: Proxy[] }> {
  return api("/api/proxies");
}

export async function importProxies(text: string): Promise<ImportProxiesResult> {
  return api("/api/proxies", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function testAllProxies(): Promise<{ data: Array<{ id: number; success: boolean; latencyMs?: number; error?: string }> }> {
  return api("/api/proxies/test-all", { method: "POST" });
}

export async function testProxy(id: number): Promise<{ id: number; success: boolean; latencyMs?: number; error?: string }> {
  return api(`/api/proxies/${id}/test`, { method: "POST" });
}

export async function assignProxies(): Promise<{ success: boolean; assigned: number }> {
  return api("/api/proxies/assign", { method: "POST" });
}

export async function toggleProxy(id: number, enabled: boolean): Promise<{ success: boolean; proxy: Proxy }> {
  return api(`/api/proxies/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteProxy(id: number): Promise<{ success: boolean }> {
  return api(`/api/proxies/${id}`, { method: "DELETE" });
}

export async function bindAccountProxy(accountId: number, proxyId: number | null): Promise<{ success: boolean }> {
  return api(`/api/proxies/accounts/${accountId}/bind`, {
    method: "POST",
    body: JSON.stringify({ proxyId }),
  });
}
