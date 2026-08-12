#!/usr/bin/env bun
/**
 * postman2api CLI
 *
 * Usage:
 *   bun src/cli.ts serve [--port 1930]        Start server
 *   bun src/cli.ts login <email> <password>   Login Postman account via browser
 *   bun src/cli.ts accounts                    List accounts
 *   bun src/cli.ts quota                       Check account quotas
 *   bun src/cli.ts status                      Show config overview
 */

import { db } from "./db/index";
import { accounts } from "./db/schema";
import { config } from "./config";
import { loginPostmanAccount } from "./auth/bridge";
import { warmupAccount } from "./auth/warmup";

const C: Record<string, string> = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m",
};

function c(text: string, color: string): string {
  return `${C[color]}${text}${C.reset}`;
}

function usage(): void {
  console.log(`postman2api

Usage:
  bun src/cli.ts serve [--port 1930]        Start server
  bun src/cli.ts login <email> <password>   Login Postman via browser (Camoufox)
  bun src/cli.ts accounts                    List accounts
  bun src/cli.ts quota                       Check account quotas
  bun src/cli.ts status                      Show config overview
  bun src/cli.ts migrate                     Run database migration
`);
}

async function cmdServe(args: string[]): Promise<void> {
  if ("--port" in args) {
    const i = args.indexOf("--port");
    if (i + 1 < args.length) (config as any).port = Number(args[i + 1]);
  }
  await import("./index");
}

async function cmdLogin(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.log(c("Usage: bun src/cli.ts login <email> <password>", "red"));
    return;
  }
  const [email, password] = args;
  const headless = args.includes("--headless");
  console.log(c(`Logging in ${email} via Camoufox (headless=${headless})...`, "cyan"));
  const result = await loginPostmanAccount(email, password, headless, (log) => {
    console.log(c(`  [${log.step}]`, "blue") + ` ${log.msg}`);
  });
  if (result.success) {
    console.log(c(`✔ Account ${email} added (id=${result.accountId})`, "green"));
  } else {
    console.log(c(`✘ Login failed: ${result.error}`, "red"));
  }
}

async function cmdAccounts(): Promise<void> {
  const allAccounts = await db.select().from(accounts);
  if (allAccounts.length === 0) {
    console.log(c("No accounts", "yellow"));
    return;
  }
  console.log(c(`\n--- Accounts (${allAccounts.length}) ---`, "cyan"));
  for (const a of allAccounts) {
    console.log(`  ${a.id}  ${a.email}  ${c(a.status, a.status === "active" ? "green" : "red")}  ${a.enabled ? "" : c("disabled", "yellow")}`);
  }
}

async function cmdQuota(): Promise<void> {
  const allAccounts = await db.select().from(accounts);
  if (allAccounts.length === 0) {
    console.log(c("No accounts", "yellow"));
    return;
  }
  for (const a of allAccounts) {
    const result = await warmupAccount(a.id);
    console.log(c(`\n${a.email} (${a.status})`, "bold"));
    if (!result.success) {
      console.log(`  Error: ${result.error}`);
    } else {
      console.log(`  ${c("Healthy", "green")}`);
    }
  }
}

async function cmdStatus(): Promise<void> {
  console.log(c("\n--- postman2api Status ---", "cyan"));
  console.log(`Database      : ${c(config.databasePath, "blue")}`);
  console.log(`Port          : ${c(String(config.port), "blue")}`);
  console.log(`Admin Key     : ${maskSecret(config.adminKey)}`);
  console.log(`API Key       : ${maskSecret(config.apiKey)}`);
  console.log(`Browser       : ${c(config.browserEngine, "blue")}`);
  console.log(`Python Path   : ${c(config.pythonPath, "blue")}`);

  const allAccounts = await db.select().from(accounts);
  const active = allAccounts.filter((a) => a.status === "active" && a.enabled);
  console.log(`Accounts      : ${allAccounts.length} total, ${c(String(active.length), "green")} active`);
}

export function maskSecret(value: string): string {
  if (!value) return "Not set";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    return;
  }
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "serve": await cmdServe(rest); break;
    case "login": await cmdLogin(rest); break;
    case "accounts": await cmdAccounts(); break;
    case "quota": await cmdQuota(); break;
    case "status": await cmdStatus(); break;
    case "migrate": await import("./db/migrate"); break;
    case "help":
    case "-h":
    case "--help": usage(); break;
    default: console.log(c(`Unknown command: ${cmd}`, "red")); usage();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(c(`Error: ${err}`, "red"));
    process.exit(1);
  });
}
