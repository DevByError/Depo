import net from "node:net";

/** Previews only ever listen on the loopback address. */
export const PREVIEW_HOST = "127.0.0.1";

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Does something already accept connections on this port? */
export function isListening(port: number, host = PREVIEW_HOST, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Free on 127.0.0.1: nothing answers there or on ::1 (a server bound to "localhost" may sit on
 * either), and we can bind it ourselves.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (port < 1 || port > 65535) return false;
  if (await isListening(port, PREVIEW_HOST)) return false;
  if (await isListening(port, "::1")) return false;
  return canBind(port, PREVIEW_HOST);
}

/** A port the OS says is free right now. */
export function randomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen({ port: 0, host: PREVIEW_HOST }, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** The preferred port when it is free, otherwise any free port (never one in `avoid`). */
export async function choosePort(preferred: number, avoid: Set<number> = new Set()): Promise<number> {
  if (preferred > 0 && !avoid.has(preferred) && (await isPortFree(preferred))) return preferred;
  for (let i = 0; i < 20; i++) {
    const p = await randomFreePort();
    if (!avoid.has(p) && (await isPortFree(p))) return p;
  }
  throw new Error("Could not find a free port on 127.0.0.1.");
}
