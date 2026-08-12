import { describe, expect, test } from "bun:test";
import { resolveStaticPath } from "../../src/utils/static-files";
import { isValidWorkspaceSubdomain } from "../../src/utils/workspace";

describe("security utilities", () => {
  test("keeps static assets inside the dashboard root", () => {
    const root = "C:\\app\\dashboard\\dist";
    expect(resolveStaticPath(root, "/assets/index.js")).toBe("C:\\app\\dashboard\\dist\\assets\\index.js");
    expect(resolveStaticPath(root, "/../secret.txt")).toBeNull();
    expect(resolveStaticPath(root, "/%2e%2e/secret.txt")).toBeNull();
  });

  test("accepts only safe Postman workspace subdomains", () => {
    expect(isValidWorkspaceSubdomain("team-alpha")).toBe(true);
    expect(isValidWorkspaceSubdomain("go")).toBe(false);
    expect(isValidWorkspaceSubdomain("evil.postman.co")).toBe(false);
    expect(isValidWorkspaceSubdomain("TEAM")).toBe(false);
  });
});
