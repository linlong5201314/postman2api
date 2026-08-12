import { describe, expect, test } from "bun:test";
import { maskSecret } from "../../src/cli";

describe("CLI secret output", () => {
  test("never prints a complete secret", () => {
    const secret = "0123456789abcdefghijklmnopqrstuvwxyz";
    const masked = maskSecret(secret);

    expect(masked).not.toContain(secret);
    expect(masked).toBe("0123...wxyz");
  });

  test("fully masks short values", () => {
    expect(maskSecret("tiny")).toBe("********");
    expect(maskSecret("")).toBe("Not set");
  });
});
