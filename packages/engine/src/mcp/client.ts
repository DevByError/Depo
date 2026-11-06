/**
 * A minimal Model Context Protocol client: stdio (a local process) and streamable HTTP (a local
 * address). It speaks JSON-RPC 2.0 and supports what agents need: initialize, tools/list, tools/call.
 */
import { spawn } from "node:child_process";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpTransportConfig {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "depo", version: "0.1.0" };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Environment a server process gets: the basics plus what the user configured, nothing secret by default. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "TERM",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...extra };
}

export class McpClient {
  private proc: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId: string | null = null;
  private closed = false;
  stderr = "";
  serverInfo: { name?: string; version?: string } = {};

  constructor(
    private readonly cfg: McpTransportConfig,
    private readonly timeoutMs = 30_000,
  ) {}

  get alive(): boolean {
    return (
      !this.closed && (this.cfg.transport === "http" || (this.proc !== null && this.proc.exitCode === null))
    );
  }

  async connect(): Promise<void> {
    if (this.cfg.transport === "stdio") this.startProcess();
    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT,
    })) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init?.serverInfo ?? {};
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: {
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
          annotations?: { readOnlyHint?: boolean };
        }[];
        nextCursor?: string;
      };
      for (const t of r.tools ?? []) {
        tools.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          readOnly: t.annotations?.readOnlyHint === true,
        });
      }
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args ?? {} }, signal, 120_000)) as {
      content?: {
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        resource?: { text?: string; uri?: string };
      }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const parts = (r.content ?? []).map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
      return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""} omitted]`;
    });
    if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join("\n").trim() || "(no output)", isError: r.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("The MCP connection was closed."));
    }
    this.pending.clear();
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && proc.pid) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => {});
        } else proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  // ---- stdio -----------------------------------------------------------------------------

  private startProcess() {
    const { command, args = [], env, cwd } = this.cfg;
    if (!command) throw new Error("No command to start.");
    const win = process.platform === "win32";
    // Windows: npx, uvx and friends are .cmd files; cmd.exe starts them.
    const proc = win
      ? spawn("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(winQuote).join(" ")], {
          env: cleanEnv(env),
          cwd,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          windowsVerbatimArguments: true,
        })
      : spawn(command, args, { env: cleanEnv(env), cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (d: string) => this.onData(d));
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    proc.on("error", (err) => this.failAll(new Error(`Could not start "${command}": ${err.message}`)));
    proc.on("exit", (code) => {
      this.failAll(
        new Error(
          `The MCP server stopped (exit ${code ?? "?"}). ${this.stderr.trim().split("\n").slice(-3).join(" ")}`.trim(),
        ),
      );
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as RpcMessage);
      } catch {
        // not JSON: servers sometimes print logs on stdout; ignore
      }
    }
    if (this.buffer.length > 8_000_000) this.buffer = "";
  }

  private onMessage(m: RpcMessage) {
    if (typeof m.id === "number" && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`MCP error ${m.error.code}: ${m.error.message}`));
      else p.resolve(m.result);
    } else if (m.method && m.id !== undefined && m.id !== null) {
      // A request from the server (sampling, roots, ping): Depo offers none of them.
      const reply =
        m.method === "ping"
          ? { jsonrpc: "2.0", id: m.id, result: {} }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not supported by Depo" } };
      this.proc?.stdin?.write(`${JSON.stringify(reply)}\n`);
    }
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // ---- requests --------------------------------------------------------------------------

  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    if (this.closed) throw new Error("The MCP connection is closed.");
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    if (this.cfg.transport === "http") return this.httpRequest(msg, signal, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The MCP server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.proc?.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("The MCP server is not running."));
        return;
      }
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }

  private async notify(method: string): Promise<void> {
    const msg = { jsonrpc: "2.0", method };
    if (this.cfg.transport === "http") {
      await this.httpPost(msg, undefined, 10_000).catch(() => {});
      return;
    }
    this.proc?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private async httpPost(msg: object, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    signal?.addEventListener("abort", () => ctl.abort(), { once: true });
    try {
      return await fetch(this.cfg.url ?? "", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL,
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(msg),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpRequest(
    msg: { id: number },
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const res = await this.httpPost(msg, signal, timeoutMs).catch((err: unknown) => {
      throw new Error(
        `Could not reach the MCP server at ${this.cfg.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`The MCP server answered ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    let reply: RpcMessage | null = null;
    if (type.includes("text/event-stream")) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          const m = JSON.parse(data) as RpcMessage;
          if (m.id === msg.id) reply = m;
        } catch {
          // skip
        }
      }
    } else {
      reply = (await res.json()) as RpcMessage;
    }
    if (!reply) throw new Error("The MCP server sent no answer.");
    if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }
}

function winQuote(s: string): string {
  return /[\s&|<>^"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
