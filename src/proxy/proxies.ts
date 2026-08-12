export {
  assignProxiesRoundRobin,
  bindProxyToAccount as setAccountProxy,
  bootstrapProxiesFromEnv as bootstrapProxies,
  importProxies,
  listProxies,
  testProxy,
} from "../proxies/service";
export { parseProxyBatch as parseProxyText, parseProxyLine, maskProxyUrl } from "../proxies/parser";
export type { ParsedProxy, ProxyProtocol } from "../proxies/parser";

import type { Account } from "../db/schema";
import { getProxyForAccount } from "../proxies/service";

export async function getAccountProxyUrl(account: Account): Promise<string | null> {
  return (await getProxyForAccount(account)) as string | null;
}
