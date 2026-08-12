import { describe, expect, test } from "bun:test";
import { parseProxyBatch, parseProxyLine } from "../../src/proxies/parser";

describe("proxy parser", () => {
  test("parses common HTTP proxy formats and removes duplicates", () => {
    const result = parseProxyBatch([
      "http://user:pass@127.0.0.1:8080",
      "user:pass@127.0.0.1:8080",
      "127.0.0.2:3128",
    ].join("\n"));

    expect(result.proxies).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("rejects SOCKS proxies instead of falling back to a direct request", () => {
    expect(parseProxyLine("socks5://127.0.0.1:1080")).toEqual({
      error: "SOCKS proxies are not supported by Bun fetch proxy",
    });
  });
});
