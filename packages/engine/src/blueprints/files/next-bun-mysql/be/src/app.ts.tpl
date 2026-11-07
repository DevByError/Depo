import { login, logout, me, register } from "./auth/routes";
import type { Config } from "./config";
import type { Store } from "./db/store";
import { BadRequest, clientKey, fail, json } from "./http";
import { Limiter } from "./limiter";

type Server = { requestIP(r: Request): { address: string } | null };
type Handler = (req: Request, server?: Server) => Promise<Response> | Response;

/**
 * The API: every route in one table. Add a route here, its handler in its own folder (like
 * auth/), and a test in app.test.ts.
 */
export function createApp(opts: { store: Store; config: Config; limiter?: Limiter }) {
  const deps = { store: opts.store, config: opts.config, limiter: opts.limiter ?? new Limiter() };
  const routes: Record<string, Handler> = {
    "GET /api/health": () => json(200, { ok: true, store: deps.store.kind }),
    "POST /api/auth/register": (req) => register(deps, req),
    "POST /api/auth/login": (req, server) => login(deps, req, clientKey(req, server)),
    "POST /api/auth/logout": (req) => logout(deps, req),
    "GET /api/auth/me": (req) => me(deps, req),
  };

  /** CORS for the web app when it calls the API directly (the dev proxy is same-origin). */
  const cors = (req: Request, res: Response): Response => {
    const origin = req.headers.get("origin");
    if (origin && origin === deps.config.webOrigin) {
      res.headers.set("access-control-allow-origin", origin);
      res.headers.set("access-control-allow-credentials", "true");
      res.headers.set("vary", "origin");
    }
    return res;
  };

  async function fetch(req: Request, server?: Server): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      const res = new Response(null, { status: 204 });
      res.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.headers.set("access-control-allow-headers", "content-type");
      return cors(req, res);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    try {
      const res = handler ? await handler(req, server) : fail(404, "not_found", "There is no such API route.");
      return cors(req, res);
    } catch (err) {
      if (err instanceof BadRequest) return cors(req, fail(400, "bad_request", err.message));
      console.error(err);
      return cors(req, fail(500, "server_error", "Something went wrong on the server."));
    }
  }

  return { fetch };
}
