import { isLocalUrl } from "@depo/model-gateway";
import { newId } from "@depo/shared";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApprovalCenter } from "../approvals";
import type { AppDb } from "../db";
import { mcpServers } from "../db/schema";
import type { EventBus } from "../events/bus";
import { type VetFinding, type VetReport, vetText } from "../skills/vet";
import type { AgentTool } from "../tools/index";
import { ToolError } from "../tools/paths";
import { classifyCommand } from "../tools/shell/policy";
import { McpClient, type McpToolInfo, type McpTransportConfig } from "./client";

export interface McpServerDto {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  /** Variable names only: the values stay private. */
  envKeys: string[];
  url: string | null;
  enabled: boolean;
  autoApprove: boolean;
  vetting: VetReport | null;
  tools: { name: string; description: string; readOnly: boolean }[];
  status: "stopped" | "running";
  createdAt: string;
}

export interface McpInput {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const MAX_OUTPUT = 24_000;

interface Live {
  client: McpClient;
  at: number;
}

/**
 * MCP servers the user adds (a local process or a local address). A server is tested and scanned
 * before it can be enabled; its tools then appear next to Depo's own, and every call is asked about
 * unless the tool is read-only or the user trusts the server.
 */
export class McpManager {
  private readonly live = new Map<string, Live>();
  /** `${taskId}:${server}:${tool}` the user allowed during this run of the engine. */
  private readonly allowed = new Set<string>();

  constructor(
    private readonly o: { db: AppDb; bus: EventBus; approvals: ApprovalCenter; connectTimeoutMs?: number },
  ) {}

  list(): McpServerDto[] {
    return this.o.db
      .select()
      .from(mcpServers)
      .orderBy(asc(mcpServers.name))
      .all()
      .map((r) => this.toDto(r));
  }

  get(id: string): McpServerDto {
    const r = this.row(id);
    return this.toDto(r);
  }

  private row(id: string) {
    const r = this.o.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!r) throw new Error(`Unknown MCP server: ${id}`);
    return r;
  }

  private toDto(r: typeof mcpServers.$inferSelect): McpServerDto {
    return {
      id: r.id,
      name: r.name,
      transport: r.transport as "stdio" | "http",
      command: r.command,
      args: JSON.parse(r.args) as string[],
      envKeys: Object.keys(JSON.parse(r.env) as Record<string, string>),
      url: r.url,
      enabled: r.enabled === 1,
      autoApprove: r.autoApprove === 1,
      vetting: r.vetting ? (JSON.parse(r.vetting) as VetReport) : null,
      tools: JSON.parse(r.tools) as McpServerDto["tools"],
      status: this.live.get(r.id)?.client.alive ? "running" : "stopped",
      createdAt: r.createdAt,
    };
  }

  add(input: McpInput): McpServerDto {
    const name = input.name.trim().toLowerCase();
    if (!NAME.test(name))
      throw new Error("Server names use lowercase letters, digits, dashes and underscores.");
    if (this.o.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get())
      throw new Error(`A server named "${name}" already exists.`);
    if (input.transport === "stdio") {
      if (!input.command?.trim()) throw new Error("Give the command that starts the server.");
      const verdict = classifyCommand([input.command, ...(input.args ?? [])].join(" "));
      if (verdict.decision === "deny") throw new Error(`That command is not allowed: ${verdict.reason}.`);
    } else {
      if (!input.url || !isLocalUrl(input.url))
        throw new Error(
          "MCP over HTTP is limited to this PC and your local network (localhost or a private address).",
        );
    }
    const now = new Date().toISOString();
    const id = newId("mcp");
    this.o.db
      .insert(mcpServers)
      .values({
        id,
        name,
        transport: input.transport,
        command: input.command?.trim() ?? null,
        args: JSON.stringify(input.args ?? []),
        env: JSON.stringify(input.env ?? {}),
        url: input.url ?? null,
        enabled: 0,
        autoApprove: 0,
        vetting: null,
        tools: "[]",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(id);
  }

  async remove(id: string): Promise<{ ok: true }> {
    await this.stop(id);
    this.o.db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
    return { ok: true };
  }

  setAutoApprove(id: string, on: boolean): McpServerDto {
    this.row(id);
    this.o.db
      .update(mcpServers)
      .set({ autoApprove: on ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(mcpServers.id, id))
      .run();
    return this.get(id);
  }

  async setEnabled(id: string, enabled: boolean, force = false): Promise<McpServerDto> {
    const r = this.row(id);
    if (enabled) {
      if (!r.vetting)
        throw new Error("Test the server first: Depo has to connect, list its tools and scan them.");
      const report = JSON.parse(r.vetting) as VetReport;
      if (report.verdict === "blocked" && !force)
        throw new Error(
          "The security scan found serious problems with this server. Read the report; enable it only if you trust it.",
        );
    } else await this.stop(id);
    this.o.db
      .update(mcpServers)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(mcpServers.id, id))
      .run();
    return this.get(id);
  }

  private config(r: typeof mcpServers.$inferSelect): McpTransportConfig {
    return {
      transport: r.transport as "stdio" | "http",
      ...(r.command ? { command: r.command } : {}),
      args: JSON.parse(r.args) as string[],
      env: JSON.parse(r.env) as Record<string, string>,
      ...(r.url ? { url: r.url } : {}),
    };
  }

  /** Connect, list the tools and scan the server and its tool descriptions. */
  async test(id: string): Promise<McpServerDto> {
    const r = this.row(id);
    await this.stop(id);
    const findings: VetFinding[] = [];
    const cfg = this.config(r);
    if (cfg.transport === "stdio") {
      const line = [cfg.command ?? "", ...(cfg.args ?? [])].join(" ");
      if (/\b(npx|uvx|pipx|bunx|pnpm dlx|dlx|docker run)\b/i.test(line))
        findings.push({
          severity: "medium",
          rule: "runtime-download",
          file: "command",
          line: 0,
          text: `Downloads and runs code each time: ${line.slice(0, 120)}`,
        });
      if (/\b(cmd(\.exe)?\s+\/c|powershell|pwsh|bash\s+-c|sh\s+-c)\b/i.test(line))
        findings.push({
          severity: "high",
          rule: "shell-wrapper",
          file: "command",
          line: 0,
          text: `Runs through a shell: ${line.slice(0, 120)}`,
        });
      const secrets = Object.keys(cfg.env ?? {}).filter((k) =>
        /key|token|secret|password|credential/i.test(k),
      );
      if (secrets.length)
        findings.push({
          severity: "low",
          rule: "secrets-passed",
          file: "environment",
          line: 0,
          text: `Gives the server these secrets: ${secrets.join(", ")}`,
        });
    }
    const client = new McpClient(cfg, this.o.connectTimeoutMs ?? 30_000);
    let tools: McpToolInfo[] = [];
    try {
      await client.connect();
      tools = await client.listTools();
    } catch (err) {
      await client.close();
      const report: VetReport = {
        verdict: "blocked",
        findings: [
          ...findings,
          {
            severity: "high",
            rule: "unreachable",
            file: "connection",
            line: 0,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        files: 0,
        scripts: 0,
        scannedAt: new Date().toISOString(),
      };
      this.save(id, report, []);
      return this.get(id);
    }
    // Tool poisoning: instructions hidden in tool names and descriptions.
    for (const t of tools) {
      findings.push(
        ...vetText(`tool ${t.name}`, `${t.description}\n${JSON.stringify(t.inputSchema).slice(0, 4000)}`),
      );
    }
    const report: VetReport = {
      verdict: findings.some((f) => f.severity === "high")
        ? "blocked"
        : findings.length
          ? "warnings"
          : "clean",
      findings,
      files: tools.length,
      scripts: 0,
      scannedAt: new Date().toISOString(),
    };
    this.save(id, report, tools);
    this.live.set(id, { client, at: Date.now() });
    this.o.bus.emit({
      agent: "engine",
      type: "info",
      text: `MCP server ${r.name}: ${tools.length} tools (${report.verdict})`,
      details: { server: r.name, tools: tools.length },
      status: "succeeded",
    });
    return this.get(id);
  }

  private save(id: string, report: VetReport, tools: McpToolInfo[]) {
    this.o.db
      .update(mcpServers)
      .set({
        vetting: JSON.stringify(report),
        tools: JSON.stringify(
          tools.map((t) => ({
            name: t.name,
            description: t.description.slice(0, 500),
            readOnly: t.readOnly,
            schema: t.inputSchema,
          })),
        ),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpServers.id, id))
      .run();
  }

  private async ensure(id: string): Promise<McpClient> {
    const cur = this.live.get(id);
    if (cur?.client.alive) return cur.client;
    const r = this.row(id);
    const client = new McpClient(this.config(r), this.o.connectTimeoutMs ?? 30_000);
    await client.connect();
    this.live.set(id, { client, at: Date.now() });
    return client;
  }

  async stop(id: string): Promise<void> {
    const cur = this.live.get(id);
    this.live.delete(id);
    await cur?.client.close();
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map((id) => this.stop(id)));
  }

  /** Tools of every enabled server, shaped like Depo's own tools. */
  extrasFor(
    _agentId: string,
    _projectId: string,
    run: { taskId: string },
  ): { tools: AgentTool<z.ZodType>[]; allow: string[]; prompt: string } {
    const tools: AgentTool<z.ZodType>[] = [];
    const lines: string[] = [];
    for (const r of this.o.db.select().from(mcpServers).where(eq(mcpServers.enabled, 1)).all()) {
      const stored = JSON.parse(r.tools) as (McpServerDto["tools"][number] & {
        schema?: Record<string, unknown>;
      })[];
      for (const t of stored) {
        const name = `mcp__${r.name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        lines.push(`- ${name}: ${t.description.split("\n")[0]?.slice(0, 120) ?? ""}`);
        const needed = Array.isArray(t.schema?.required) ? (t.schema?.required as string[]) : [];
        tools.push({
          name,
          description: `[MCP server ${r.name}] ${t.description}`.slice(0, 1000),
          schema: z.record(z.string(), z.unknown()),
          jsonSchema: t.schema ?? { type: "object", properties: {} },
          run: async (args, ctx) => {
            const a = args as Record<string, unknown>;
            const missing = needed.filter((k) => a[k] === undefined);
            if (missing.length) throw new ToolError(`Missing required argument(s): ${missing.join(", ")}.`);
            const key = `${ctx.taskId ?? run.taskId}:${r.name}:${t.name}`;
            if (r.autoApprove !== 1 && !t.readOnly && !this.allowed.has(key)) {
              const ok = await this.o.approvals.request(
                {
                  projectId: ctx.projectId,
                  taskId: ctx.taskId,
                  agent: ctx.agent,
                  kind: "other",
                  title: `Allow MCP tool ${r.name}: ${t.name}?`,
                  reason: "This tool comes from an MCP server and can act outside the project.",
                  details: { command: `${t.name} ${JSON.stringify(a).slice(0, 400)}` },
                },
                ctx.signal,
              );
              if (!ok) throw new ToolError(`The user declined to run ${t.name}. Continue without it.`);
              this.allowed.add(key);
            }
            const client = await this.ensure(r.id).catch((err: unknown) => {
              throw new ToolError(err instanceof Error ? err.message : String(err));
            });
            ctx.bus.emit({
              projectId: ctx.projectId,
              taskId: ctx.taskId,
              agent: ctx.agent,
              type: "running_command",
              text: `MCP ${r.name}: ${t.name}`,
              details: { server: r.name, tool: t.name },
              status: "started",
            });
            const res = await client.callTool(t.name, a, ctx.signal).catch((err: unknown) => {
              throw new ToolError(err instanceof Error ? err.message : String(err));
            });
            const text =
              res.text.length > MAX_OUTPUT ? `${res.text.slice(0, MAX_OUTPUT)}\n[output cut]` : res.text;
            if (res.isError) throw new ToolError(text);
            return text;
          },
        });
      }
    }
    const prompt = lines.length
      ? `# MCP tools\nThese tools come from MCP servers the user connected:\n${lines.join("\n")}`
      : "";
    return { tools, allow: tools.map((t) => t.name), prompt };
  }
}
