import { app } from "./app";
import { stopWarmupScheduler, startWarmupScheduler } from "./auth/warmup";
import { config, validateRuntimeConfig } from "./config";
import { client } from "./db/index";
import { runMigrations } from "./db/migrate";
import { bootstrapProxies } from "./proxy/proxies";

async function startServer(): Promise<ReturnType<typeof Bun.serve>> {
  const configErrors = validateRuntimeConfig(config, process.env);
  if (configErrors.length > 0) {
    throw new Error(`Invalid configuration:\n${configErrors.map((error) => `  - ${error}`).join("\n")}`);
  }

  await runMigrations();
  const bootstrapResult = await bootstrapProxies();
  if (bootstrapResult.created.length > 0 || bootstrapResult.duplicates > 0 || bootstrapResult.errors.length > 0) {
    console.log(
      `[proxy] Bootstrap complete: ${bootstrapResult.created.length} created, ` +
      `${bootstrapResult.duplicates} duplicate, ${bootstrapResult.errors.length} invalid`,
    );
  }

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
    idleTimeout: 0,
  });

  if (config.warmupEnabled) startWarmupScheduler();

  console.log(`[postman2api] Server running on http://${config.host}:${config.port}`);
  console.log("[postman2api] OpenAI endpoint: /v1/chat/completions");
  console.log("[postman2api] Anthropic endpoint: /v1/messages");
  console.log("[postman2api] Dashboard: /");
  return server;
}

if (import.meta.main) {
  try {
    const server = await startServer();
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopWarmupScheduler();
      server.stop();
      client.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    console.error(`[postman2api] ${error instanceof Error ? error.message : String(error)}`);
    client.close();
    process.exitCode = 1;
  }
}
