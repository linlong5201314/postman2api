import { config } from "../config";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { encrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { eq } from "drizzle-orm";
import { decodeAccountTokens, encodeAccountTokens, normalizeTokens } from "./tokens";

const LOGIN_PROCESS_TIMEOUT_MS = {
  headless: 240_000,
  headed: 330_000,
} as const;

// The login script locates the Camoufox anti-detection browser under
// $XDG_CACHE_HOME/camoufox (or $HOME/.cache/camoufox). Camoufox is fetched
// at image build time into /home/bun/.cache/camoufox, so when the server is
// started outside the Docker entrypoint (e.g. directly as root) the spawned
// Python process must still resolve that directory, otherwise it silently
// falls back to plain Chromium and Cloudflare blocks the login.
function browserCacheEnv(): Record<string, string> {
  if (process.platform !== "linux") return {};
  const home = process.env.HOME;
  if (home && home !== "/root" && process.env.XDG_CACHE_HOME) return {};
  return {
    HOME: home && home !== "/root" ? home : "/home/bun",
    XDG_CACHE_HOME: "/home/bun/.cache",
  };
}

export interface PostmanLoginResult {
  postman_sid: string;
  user_id: string;
  workspace_id: string;
  workspace_subdomain: string;
  error?: string;
}

export interface LoginLogEntry {
  step: string;
  msg: string;
  level: string;
  ts: number;
}

export async function loginPostmanAccount(
  email: string,
  password: string,
  headless: boolean,
  proxy?: string,
  onLog?: (log: LoginLogEntry) => void,
): Promise<{ success: boolean; accountId?: number; error?: string; logs?: string[] }> {
  let debugLines: string[] = [];
  const fail = (error: string) => {
    broadcast({ type: "login_done", data: { email, success: false, error } });
    console.error(`[auth:bridge] Login failed for ${email}: ${error}`);
    const lastLines = debugLines.slice(-30);
    if (lastLines.length > 0) {
      console.error(`[auth:bridge] Login script log (last ${lastLines.length} lines):\n${lastLines.join("\n")}`);
    }
    return { success: false as const, error, logs: lastLines };
  };

  if (!config.enableBrowserLogin) {
    return fail("Browser login is disabled. Add account tokens manually.");
  }
  const scriptPath = config.authScriptCwd + "/postman_login.py";

  try {
    const proc = Bun.spawn({
      cmd: [
        config.pythonPath, scriptPath,
        ...(headless ? ["--headless"] : []),
      ],
      cwd: config.authScriptCwd,
      env: {
        ...process.env,
        ...browserCacheEnv(),
        POSTMAN_LOGIN_HEADLESS: String(headless),
        CAMOUFOX_HEADLESS: headless ? "true" : "false",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(JSON.stringify({ email, password, headless, proxy: proxy || "" }));
    proc.stdin.end();

    const processTimeoutMs = headless
      ? LOGIN_PROCESS_TIMEOUT_MS.headless
      : LOGIN_PROCESS_TIMEOUT_MS.headed;
    let processTimer: ReturnType<typeof setTimeout> | undefined;

    const stderrLines: string[] = [];
    const stderrReader = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          stderrLines.push(line);
          try {
            const logEntry = JSON.parse(line) as LoginLogEntry;
            onLog?.(logEntry);
            broadcast({
              type: "login_log",
              data: { email, ...logEntry },
            });
          } catch {
            broadcast({
              type: "login_log",
              data: { email, step: "raw", msg: line, level: "info", ts: Date.now() / 1000 },
            });
          }
        }
      }
      if (buffer.trim()) {
        try {
          const logEntry = JSON.parse(buffer) as LoginLogEntry;
          onLog?.(logEntry);
          broadcast({
            type: "login_log",
            data: { email, ...logEntry },
          });
        } catch {
          broadcast({
            type: "login_log",
            data: { email, step: "raw", msg: buffer, level: "info", ts: Date.now() / 1000 },
          });
        }
      }
    })();

    const stdoutReader = new Response(proc.stdout).text();
    const timeout = new Promise<never>((_, reject) => {
      processTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // The process may have exited between the timeout and the signal.
        }
        reject(new Error(`Login process timed out after ${Math.ceil(processTimeoutMs / 1000)} seconds`));
      }, processTimeoutMs);
    });

    let stdout: string;
    let exitCode: number;
    try {
      [stdout, , exitCode] = await Promise.race([
        Promise.all([stdoutReader, stderrReader, proc.exited]),
        timeout,
      ]);
    } finally {
      if (processTimer) clearTimeout(processTimer);
      if (proc.exitCode === null) {
        try {
          proc.kill();
        } catch {
          // Best-effort cleanup; the process can exit while this runs.
        }
      }
    }

    if (exitCode !== 0) {
      const lastErr = stderrLines.length > 0
        ? stderrLines.filter(l => l.includes('"level":"error"')).pop() || stderrLines[stderrLines.length - 1]
        : "";
      let errorMsg = "Login script failed";
      try {
        const parsed = JSON.parse(lastErr);
        errorMsg = parsed.msg || errorMsg;
      } catch {
        errorMsg = lastErr || errorMsg;
      }
      console.error("[auth:bridge] Python script error:", errorMsg);
      return fail(errorMsg);
    }

    const result: PostmanLoginResult = JSON.parse(stdout.trim());

    if (result.error) {
      return fail(result.error);
    }

    if (!result.postman_sid || !result.workspace_subdomain) {
      return fail("Incomplete tokens from login script");
    }

    const tokens = normalizeTokens({
      postman_sid: result.postman_sid,
      user_id: result.user_id,
      workspace_id: result.workspace_id,
      workspace_subdomain: result.workspace_subdomain,
    });
    if (!tokens) return fail("Invalid workspace or incomplete tokens from login script");

    const encryptedPassword = encrypt(password);
    const tokensJson = encodeAccountTokens(tokens);

    const existing = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);

    let accountId: number;

    if (existing.length > 0) {
      const [updated] = await db.update(accounts)
        .set({
          password: encryptedPassword,
          tokens: tokensJson,
          status: "active",
          lastLoginAt: new Date(),
          updatedAt: new Date(),
          errorMessage: null,
        })
        .where(eq(accounts.id, existing[0]!.id))
        .returning({ id: accounts.id });
      accountId = updated!.id;
    } else {
      const [created] = await db.insert(accounts).values({
        email,
        password: encryptedPassword,
        tokens: tokensJson,
        status: "active",
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning({ id: accounts.id });
      accountId = created!.id;
    }

    broadcast({ type: "account_added", data: { id: accountId, email, status: "active" } });
    broadcast({ type: "login_done", data: { email, success: true } });

    console.log(`[auth:bridge] Account ${email} logged in successfully (id=${accountId})`);
    return { success: true, accountId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[auth:bridge] Error:", msg);
    return fail(msg);
  }
}

export async function validatePostmanSession(accountId: number): Promise<boolean> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account?.tokens) return false;

  try {
    return decodeAccountTokens(account.tokens) !== null;
  } catch {
    return false;
  }
}
