import { resolve, relative, sep } from "node:path";

export function resolveStaticPath(root: string, requestPath: string): string | null {
  const cleanPath = decodeURIComponent(requestPath.split("?")[0] || "/");
  const relativePath = cleanPath === "/" || cleanPath === "/index.html"
    ? "index.html"
    : cleanPath.replace(/^\/+/, "");
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedFile);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || resolve(rel) === resolvedFile) {
    return null;
  }
  return resolvedFile;
}
