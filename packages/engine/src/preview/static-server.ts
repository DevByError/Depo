import fs from "node:fs";
import path from "node:path";
import { PREVIEW_HOST } from "./ports";

/** Content types for the files a static site usually has. Anything else is sent as bytes. */
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request path to a file inside `root`, or null when it must not be served: anything that
 * leaves the folder (`..`, encoded slashes, drive letters, links pointing outside), hidden files
 * and folders (`.env`, `.git`), and Windows stream names (`file::$DATA`).
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes(":")) return null;
  const parts = decoded.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.some((p) => p === ".." || p.startsWith("."))) return null;
  const base = path.resolve(root);
  const abs = path.join(base, ...parts);
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // A link inside the folder may point anywhere: check where the file really is.
  try {
    const real = fs.realpathSync(abs);
    const realBase = fs.realpathSync(base);
    const realRel = path.relative(realBase, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
    return real;
  } catch {
    return abs; // does not exist (yet): the caller answers 404
  }
}

export interface StaticServer {
  port: number;
  url: string;
  stop(): void;
}

/** Serve `root` on 127.0.0.1:`port`. Pages are never cached, so a reload shows the latest files. */
export function startStaticServer(
  root: string,
  port: number,
  onRequest?: (line: string) => void,
): StaticServer {
  const send = (file: string, method: string) =>
    new Response(method === "HEAD" ? null : Bun.file(file), {
      headers: {
        "Content-Type": mimeType(file),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  const indexOf = (dir: string) => {
    const f = path.join(dir, "index.html");
    return fs.existsSync(f) ? f : null;
  };
  const server = Bun.serve({
    hostname: PREVIEW_HOST,
    port,
    fetch(req) {
      const u = new URL(req.url);
      const method = req.method.toUpperCase();
      let status = 200;
      const log = () => onRequest?.(`${method} ${u.pathname} ${status}`);
      if (method !== "GET" && method !== "HEAD") {
        status = 405;
        log();
        return new Response("Method not allowed", { status, headers: { Allow: "GET, HEAD" } });
      }
      const abs = resolveStaticPath(root, u.pathname);
      if (!abs) {
        status = 403;
        log();
        return new Response("Forbidden", { status });
      }
      let file: string | null = null;
      try {
        const st = fs.statSync(abs);
        file = st.isDirectory() ? indexOf(abs) : st.isFile() ? abs : null;
      } catch {
        // Single-page apps route in the browser: paths without an extension get the main page.
        if (!path.extname(abs)) file = indexOf(path.resolve(root));
      }
      if (!file) {
        status = 404;
        log();
        return new Response("Not found", {
          status,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      log();
      return send(file, method);
    },
  });
  const actual = server.port ?? port;
  return {
    port: actual,
    url: `http://${PREVIEW_HOST}:${actual}/`,
    stop: () => {
      server.stop(true);
    },
  };
}
