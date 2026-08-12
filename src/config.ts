import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");

function resolveFromRoot(value: string | undefined, fallback: string): string {
  const raw = value && value.length > 0 ? value : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  return Number(value);
}

export interface Config {
  port: number;
  host: string;
  apiKey: string;
  adminKey: string;
  databasePath: string;
  requirePersistentStorage: boolean;
  encryptionKey: string;
  browserEngine: string;
  enableBrowserLogin: boolean;
  camoufoxHeadless: boolean;
  pythonPath: string;
  authScriptCwd: string;
  requestTimeoutMs: number;
  streamFirstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
  proxyTestUrl: string;
  proxyTestTimeoutMs: number;
  proxyBootstrap: string;
  proxyBootstrapFile: string;
  warmupEnabled: boolean;
  warmupIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: configuredPort(env.PORT, 1930),
    host: env.HOST || "0.0.0.0",
    apiKey: env.API_KEY || "",
    adminKey: env.ADMIN_KEY || "",
    databasePath: resolveFromRoot(env.DATABASE_PATH, "data/postman2api.db"),
    requirePersistentStorage: env.REQUIRE_PERSISTENT_STORAGE === "true",
    encryptionKey: env.ENCRYPTION_KEY || "",
    browserEngine: env.BROWSER_ENGINE || "playwright",
    enableBrowserLogin: env.ENABLE_BROWSER_LOGIN !== "false",
    camoufoxHeadless: env.CAMOUFOX_HEADLESS !== "false",
    pythonPath: resolveFromRoot(
      env.PYTHON_PATH,
      path.join("scripts/auth/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    ),
    authScriptCwd: resolveFromRoot(env.AUTH_SCRIPT_CWD, "scripts/auth"),
    requestTimeoutMs: positiveInt(env.REQUEST_TIMEOUT_MS || env.PROVIDER_REQUEST_TIMEOUT_MS, 120_000),
    streamFirstByteTimeoutMs: positiveInt(env.STREAM_FIRST_BYTE_TIMEOUT_MS || env.TTFB_TIMEOUT_MS, 45_000),
    streamIdleTimeoutMs: positiveInt(env.STREAM_IDLE_TIMEOUT_MS || env.STREAM_READ_TIMEOUT_MS, 300_000),
    proxyTestUrl: env.PROXY_TEST_URL || "https://api.ipify.org?format=json",
    proxyTestTimeoutMs: positiveInt(env.PROXY_TEST_TIMEOUT_MS, 10_000),
    proxyBootstrap: env.PROXY_BOOTSTRAP || "",
    proxyBootstrapFile: env.PROXY_BOOTSTRAP_FILE || "",
    warmupEnabled: env.WARMUP_ENABLED !== "false",
    warmupIntervalMs: positiveInt(env.WARMUP_INTERVAL_MS, 900_000),
  };
}

export const config = loadConfig();

export function validateRuntimeConfig(candidate: Config = config, env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];
  const isProduction = env.NODE_ENV === "production";

  if (!Number.isInteger(candidate.port) || candidate.port <= 0 || candidate.port > 65_535) {
    errors.push("PORT must be a valid TCP port");
  }
  if (!candidate.host.trim()) errors.push("HOST must not be empty");

  if (isProduction) {
    if (!candidate.adminKey || candidate.adminKey.length < 24) {
      errors.push("ADMIN_KEY must be set to at least 24 characters in production");
    }
    if (!candidate.apiKey || candidate.apiKey.length < 24) {
      errors.push("API_KEY must be set to at least 24 characters in production");
    }
    if (!/^[a-f0-9]{64}$/i.test(candidate.encryptionKey)) {
      errors.push("ENCRYPTION_KEY must be exactly 64 hexadecimal characters in production");
    }
    if (candidate.requirePersistentStorage && !env.DATABASE_PATH?.trim()) {
      errors.push("DATABASE_PATH must be set when persistent storage is required");
    }
  }

  return errors;
}
