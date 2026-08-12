import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config";

export function constantTimeEqual(actual: string | null | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function isAuthorizedAdmin(authHeader: string | undefined | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  return constantTimeEqual(token, config.adminKey);
}
