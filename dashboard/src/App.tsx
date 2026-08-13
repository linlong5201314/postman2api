import { useCallback, useEffect, useState } from "react";
import {
  addAccountManual,
  assignProxies,
  bindAccountProxy,
  clearAdminKey,
  deleteAccount,
  deleteProxy,
  fetchAccounts,
  fetchProxies,
  fetchSettings,
  fetchStats,
  getAdminKey,
  importProxies,
  loginAccount,
  setAdminKey,
  setUnauthorizedHandler,
  testAllProxies,
  testProxy,
  toggleAccount,
  toggleProxy,
  warmupAccount,
  type Account,
  type Proxy,
  type Stats,
  type RuntimeSettings,
} from "./lib/api";

type Tab = "accounts" | "proxies" | "stats" | "settings";
type ToastType = "success" | "error" | "info";

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(getAdminKey()));
  const [tab, setTab] = useState<Tab>("accounts");
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthenticated(false);
      showToast("Administrator session expired. Please sign in again.", "error");
    });
    return () => setUnauthorizedHandler(undefined);
  }, [showToast]);

  if (!authenticated) {
    return <LoginPage onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <>
      <Header
        tab={tab}
        onTabChange={setTab}
        onLogout={() => {
          clearAdminKey();
          setAuthenticated(false);
        }}
      />
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
      <main className="admin-main">
        {tab === "accounts" && <AccountsTab showToast={showToast} />}
        {tab === "proxies" && <ProxiesTab showToast={showToast} />}
        {tab === "stats" && <StatsTab showToast={showToast} />}
        {tab === "settings" && <SettingsTab showToast={showToast} />}
      </main>
    </>
  );
}

function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) {
      setError("Enter the administrator key.");
      return;
    }
    setLoading(true);
    setError("");
    setAdminKey(key.trim());
    try {
      await fetchAccounts();
      onSuccess();
    } catch (cause) {
      clearAdminKey();
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">postman2api</div>
        <h1>Administrator access</h1>
        <p>Enter the server administrator key to manage accounts and proxies.</p>
        <label className="settings-row">
          <span>Administrator key</span>
          <input
            autoComplete="current-password"
            className="input"
            onChange={(event) => setKey(event.target.value)}
            placeholder="ADMIN_KEY"
            type="password"
            value={key}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="dialog-btn dialog-btn-primary login-submit" disabled={loading} type="submit">
          {loading ? "Checking..." : "Sign in"}
        </button>
        <small>This key is kept only in this browser session.</small>
      </form>
    </main>
  );
}

function Header({
  tab,
  onTabChange,
  onLogout,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onLogout: () => void;
}) {
  const labels: Record<Tab, string> = {
    accounts: "Accounts",
    proxies: "Proxies",
    stats: "Stats",
    settings: "Settings",
  };

  return (
    <header className="admin-header">
      <div className="admin-header-inner">
        <div className="admin-brand">postman2api</div>
        <nav className="admin-nav" aria-label="Dashboard sections">
          {(Object.keys(labels) as Tab[]).map((item) => (
            <button
              className={`admin-nav-link ${tab === item ? "active" : ""}`}
              key={item}
              onClick={() => onTabChange(item)}
              type="button"
            >
              {labels[item]}
            </button>
          ))}
        </nav>
        <button className="header-logout" onClick={onLogout} type="button">Sign out</button>
      </div>
    </header>
  );
}

function AccountsTab({ showToast }: { showToast: (message: string, type?: ToastType) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      const [accountResult, proxyResult] = await Promise.all([fetchAccounts(), fetchProxies()]);
      setAccounts(accountResult.data);
      setProxies(proxyResult.data);
    } catch (cause) {
      if (!silent) showToast(messageOf(cause), "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  usePoll(load);

  const activeAccounts = accounts.filter((account) => account.status === "active" && account.enabled).length;
  const quotaRemaining = accounts.reduce((total, account) => total + Number(account.quotaRemaining || 0), 0);

  const changeBinding = async (accountId: number, value: string) => {
    try {
      await bindAccountProxy(accountId, value ? Number(value) : null);
      showToast("Proxy binding updated.");
      await load(true);
    } catch (cause) {
      showToast(messageOf(cause), "error");
    }
  };

  return (
    <>
      <PageHeader
        action={<button className="page-action-btn page-action-btn-primary" onClick={() => setShowAdd(true)} type="button">Add account</button>}
        subtitle="Accounts are refreshed every 5 seconds."
        title="Account pool"
      />
      <div className="stat-grid">
        <Stat label="Accounts" value={String(accounts.length)} />
        <Stat label="Active" value={String(activeAccounts)} />
        <Stat label="Quota remaining" value={formatNumber(quotaRemaining)} />
        <Stat label="Bound proxies" value={String(accounts.filter((account) => account.proxyId).length)} />
      </div>
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Status</th>
              <th>Quota</th>
              <th>Proxy</th>
              <th>Last used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <EmptyRow colSpan={6} text="Loading accounts..." /> : null}
            {!loading && accounts.length === 0 ? <EmptyRow colSpan={6} text="No accounts have been added." /> : null}
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <strong>{account.email}</strong>
                  {account.errorMessage && <div className="table-error">{account.errorMessage}</div>}
                </td>
                <td><StatusBadge status={account.enabled ? account.status : "disabled"} /></td>
                <td>{formatNumber(account.quotaRemaining || 0)} / {formatNumber(account.quotaLimit || 0)}</td>
                <td>
                  <select
                    aria-label={`Proxy for ${account.email}`}
                    className="input compact-input"
                    onChange={(event) => void changeBinding(account.id, event.target.value)}
                    value={account.proxyId ?? ""}
                  >
                    <option value="">Automatic / none</option>
                    {proxies.map((proxy) => (
                      <option key={proxy.id} value={proxy.id}>{proxy.maskedUrl}{proxy.enabled ? "" : " (disabled)"}</option>
                    ))}
                  </select>
                </td>
                <td>{formatDate(account.lastUsedAt)}</td>
                <td>
                  <div className="row-actions">
                    <button className="row-text-btn" onClick={() => void warm(account.id)} type="button">Warm up</button>
                    <button
                      className="row-text-btn"
                      onClick={() => void toggle(account.id, !account.enabled)}
                      type="button"
                    >
                      {account.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="row-text-btn danger" onClick={() => void remove(account.id, account.email)} type="button">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} onDone={() => void load(true)} showToast={showToast} />}
    </>
  );

  async function warm(id: number) {
    try {
      const result = await warmupAccount(id);
      showToast(result.success ? "Account warmed up." : result.error || "Warmup failed.", result.success ? "success" : "error");
      await load(true);
    } catch (cause) {
      showToast(messageOf(cause), "error");
    }
  }

  async function toggle(id: number, enabled: boolean) {
    try {
      await toggleAccount(id, enabled);
      await load(true);
    } catch (cause) {
      showToast(messageOf(cause), "error");
    }
  }

  async function remove(id: number, email: string) {
    if (!window.confirm(`Delete account "${email}"?`)) return;
    try {
      await deleteAccount(id);
      showToast("Account deleted.");
      await load(true);
    } catch (cause) {
      showToast(messageOf(cause), "error");
    }
  }
}

function AddAccountModal({
  onClose,
  onDone,
  showToast,
}: {
  onClose: () => void;
  onDone: () => void;
  showToast: (message: string, type?: ToastType) => void;
}) {
  const [mode, setMode] = useState<"manual" | "login">("manual");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokens, setTokens] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      if (mode === "login") {
        await loginAccount(email, password, true);
      } else {
        await addAccountManual(email, JSON.parse(tokens));
      }
      showToast("Account added.");
      onDone();
      onClose();
    } catch (cause) {
      showToast(messageOf(cause), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add account" onClose={onClose}>
      <div className="filter-bar">
        <button className={`filter-chip ${mode === "manual" ? "active" : ""}`} onClick={() => setMode("manual")} type="button">Manual token</button>
        <button className={`filter-chip ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")} type="button">Browser login</button>
      </div>
      <label className="settings-row"><span>Email</span><input className="input" onChange={(event) => setEmail(event.target.value)} value={email} /></label>
      {mode === "login" ? (
        <label className="settings-row"><span>Password</span><input className="input" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
      ) : (
        <label className="settings-row"><span>Tokens JSON</span><textarea className="input" onChange={(event) => setTokens(event.target.value)} placeholder='{"postman_sid":"6b0c...","workspace_subdomain":"linlongli-2423114"}' value={tokens} /></label>
      )}
      <div className="dialog-actions"><button className="dialog-btn" onClick={onClose} type="button">Cancel</button><button className="dialog-btn dialog-btn-primary" disabled={saving} onClick={() => void submit()} type="button">{saving ? "Saving..." : "Add"}</button></div>
    </Modal>
  );
}

function ProxiesTab({ showToast }: { showToast: (message: string, type?: ToastType) => void }) {
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [importText, setImportText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      setProxies((await fetchProxies()).data);
    } catch (cause) {
      if (!silent) showToast(messageOf(cause), "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  usePoll(load);

  const importBatch = async () => {
    if (!importText.trim()) return;
    setBusy(true);
    try {
      const result = await importProxies(importText);
      const errors = result.errors.length ? ` ${result.errors.length} invalid line(s).` : "";
      showToast(`Imported ${result.created.length}; skipped ${result.duplicates}.${errors}`, result.errors.length ? "info" : "success");
      setImportText("");
      await load(true);
    } catch (cause) {
      showToast(messageOf(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const action = async (operation: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await operation();
      if (success) showToast(success);
      await load(true);
    } catch (cause) {
      showToast(messageOf(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        action={
          <div className="page-actions">
            <button className="page-action-btn" disabled={busy} onClick={() => void action(async () => { const result = await testAllProxies(); const failed = result.data.filter((item) => !item.success).length; showToast(`Tested ${result.data.length} proxy entries; ${failed} failed.`, failed ? "info" : "success"); }, "")} type="button">Test all</button>
            <button className="page-action-btn" disabled={busy} onClick={() => void action(async () => { const result = await assignProxies(); showToast(`Assigned ${result.assigned} account(s).`); }, "")} type="button">Assign round robin</button>
          </div>
        }
        subtitle="Only HTTP and HTTPS CONNECT proxies are supported. Credentials are masked in this view."
        title="Proxies"
      />
      <section className="settings-card proxy-import">
        <div className="section-title">Batch import</div>
        <p className="hint">One per line. Supports <code>host:port</code>, <code>host:port:user:password</code>, and full HTTP(S) URLs.</p>
        <textarea className="input" onChange={(event) => setImportText(event.target.value)} placeholder={"http://user:pass@host:port\nhost:port:user:pass"} value={importText} />
        <div className="dialog-actions"><button className="dialog-btn dialog-btn-primary" disabled={busy || !importText.trim()} onClick={() => void importBatch()} type="button">Import proxies</button></div>
      </section>
      <div className="table-card">
        <table>
          <thead><tr><th>Proxy</th><th>Status</th><th>Latency</th><th>Last error</th><th>Last test</th><th>Actions</th></tr></thead>
          <tbody>
            {loading ? <EmptyRow colSpan={6} text="Loading proxies..." /> : null}
            {!loading && proxies.length === 0 ? <EmptyRow colSpan={6} text="No proxies yet. Import a batch above." /> : null}
            {proxies.map((proxy) => (
              <tr key={proxy.id}>
                <td><strong>{proxy.maskedUrl}</strong><div className="table-secondary">{proxy.hasCredentials ? "Credentials configured" : "No credentials"}</div></td>
                <td><StatusBadge status={proxy.enabled ? proxy.status : "disabled"} /></td>
                <td>{proxy.latencyMs === null ? "—" : `${proxy.latencyMs} ms`}</td>
                <td className="table-error">{proxy.lastError || "—"}</td>
                <td>{formatDate(proxy.lastTestAt)}</td>
                <td><div className="row-actions">
                  <button className="row-text-btn" disabled={busy} onClick={() => void action(async () => { const result = await testProxy(proxy.id); if (!result.success) throw new Error(result.error || "Proxy test failed"); }, "Proxy test passed.")} type="button">Test</button>
                  <button className="row-text-btn" disabled={busy} onClick={() => void action(() => toggleProxy(proxy.id, !proxy.enabled).then(() => undefined), proxy.enabled ? "Proxy disabled." : "Proxy enabled.")} type="button">{proxy.enabled ? "Disable" : "Enable"}</button>
                  <button className="row-text-btn danger" disabled={busy} onClick={() => void removeProxy(proxy)} type="button">Delete</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  async function removeProxy(proxy: Proxy) {
    if (!window.confirm(`Delete ${proxy.maskedUrl}? Account bindings will be cleared.`)) return;
    await action(() => deleteProxy(proxy.id).then(() => undefined), "Proxy deleted.");
  }
}

function StatsTab({ showToast }: { showToast: (message: string, type?: ToastType) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const load = useCallback(async (silent = false) => {
    try {
      setStats((await fetchStats()).data);
    } catch (cause) {
      if (!silent) showToast(messageOf(cause), "error");
    }
  }, [showToast]);
  usePoll(load);

  if (!stats) return <div className="empty-state">Loading statistics...</div>;
  return (
    <>
      <PageHeader subtitle="Statistics are refreshed every 5 seconds." title="Request statistics" />
      <div className="stat-grid">
        <Stat label="Total requests" value={formatNumber(stats.totalRequests)} />
        <Stat label="Successful" value={formatNumber(stats.successRequests)} />
        <Stat label="Errors" value={formatNumber(stats.errorRequests)} />
        <Stat label="Total tokens" value={formatNumber(stats.totalTokens)} />
        <Stat label="Active accounts" value={formatNumber(stats.activeAccounts)} />
      </div>
      <div className="table-card">
        <table>
          <thead><tr><th>Model</th><th>Status</th><th>Tokens</th><th>Duration</th><th>Time</th></tr></thead>
          <tbody>
            {stats.recentRequests.length === 0 ? <EmptyRow colSpan={5} text="No requests recorded." /> : null}
            {stats.recentRequests.slice(0, 30).map((request: Record<string, unknown>) => (
              <tr key={String(request.id)}><td>{String(request.model || "—")}</td><td><StatusBadge status={String(request.status || "unknown")} /></td><td>{formatNumber(Number(request.totalTokens || 0))}</td><td>{request.durationMs ? `${request.durationMs} ms` : "—"}</td><td>{formatDate(String(request.createdAt || ""))}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SettingsTab({ showToast }: { showToast: (message: string, type?: ToastType) => void }) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  useEffect(() => {
    void fetchSettings().then((result) => setSettings(result.data)).catch((cause) => showToast(messageOf(cause), "error"));
  }, [showToast]);

  return (
    <>
      <PageHeader subtitle="Runtime configuration is managed through environment variables." title="Settings" />
      <section className="settings-card">
        {!settings ? <div className="empty-state">Loading settings...</div> : (
          <>
            <SettingStatus label="API key" enabled={settings.apiKeyConfigured} />
            <SettingStatus label="Administrator key" enabled={settings.adminKeyConfigured} />
            <SettingStatus label="Browser login" enabled={settings.browserLoginEnabled} />
            <SettingStatus label="Persistent storage required" enabled={settings.persistentStorageRequired} />
            <SettingStatus label="Proxy bootstrap" enabled={settings.proxyBootstrapConfigured} />
            <SettingStatus label="Account warmup" enabled={settings.warmupEnabled} />
          </>
        )}
      </section>
    </>
  );
}

function SettingStatus({ label, enabled }: { label: string; enabled: boolean }) {
  return <div className="settings-row"><span>{label}</span><StatusBadge status={enabled ? "configured" : "disabled"} /></div>;
}

function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="page-hd"><div><h1 className="page-title">{title}</h1><p className="page-sub">{subtitle}</p></div>{action}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat-cell"><span className="stat-label">{label}</span><strong className="stat-num">{value}</strong></div>;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, "-");
  return <span className={`badge badge-${normalized}`}>{status}</span>;
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return <tr><td className="empty-state" colSpan={colSpan}>{text}</td></tr>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-overlay open" onMouseDown={onClose}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><h2 className="modal-title">{title}</h2>{children}</section></div>;
}

function usePoll(load: (silent?: boolean) => Promise<void>) {
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [load]);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Request failed.";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
