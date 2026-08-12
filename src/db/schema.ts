import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const proxies = sqliteTable("proxies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
  protocol: text("protocol", { enum: ["http", "https"] }).notNull().default("http"),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  encryptedUrl: text("encrypted_url").notNull(),
  encryptedCredentials: text("encrypted_credentials"),
  fingerprint: text("fingerprint").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("untested"),
  latencyMs: integer("latency_ms"),
  lastTestAt: integer("last_test_at", { mode: "timestamp" }),
  lastError: text("last_error"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("proxies_fingerprint_idx").on(table.fingerprint),
  index("proxies_enabled_idx").on(table.enabled),
]);

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  password: text("password").notNull(),
  status: text("status").notNull().default("pending"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  proxyId: integer("proxy_id").references(() => proxies.id, { onDelete: "set null" }),
  tokens: text("tokens"),
  quotaLimit: real("quota_limit").default(0),
  quotaRemaining: real("quota_remaining").default(0),
  quotaResetAt: integer("quota_reset_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("accounts_email_idx").on(table.email),
  index("accounts_proxy_idx").on(table.proxyId),
]);

export const requestLogs = sqliteTable("request_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id),
  model: text("model"),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("request_logs_created_at_idx").on(table.createdAt),
  index("request_logs_status_created_at_idx").on(table.status, table.createdAt),
  index("request_logs_account_idx").on(table.accountId),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Proxy = typeof proxies.$inferSelect;
export type NewProxy = typeof proxies.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
