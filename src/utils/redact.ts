const SECRET_PATTERNS = [
  /\b(PMAK-[A-Za-z0-9_-]+)/g,
  /\b(postman\.sid=)[^;\s]+/gi,
  /\b(https?:\/\/)([^:\s/@]+):([^@\s]+)@/gi,
  /\b([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})\b/g,
];

export function redactSensitive(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, (_match, ...groups) => {
      if (groups.length >= 3 && String(groups[0]).startsWith("http")) return `${groups[0]}***:***@`;
      if (String(groups[0]).toLowerCase() === "postman.sid=") return `${groups[0]}***`;
      return "***";
    });
  }
  return message.slice(0, 500);
}

export function publicError(value: unknown, fallback = "Request failed"): string {
  const message = redactSensitive(value);
  return message || fallback;
}
