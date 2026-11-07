import { type ChatChunk, type ChatRequest, ModelGatewayError, type ModelProvider } from "@depo/model-gateway";
import type { ModelCall, ModelStat } from "@depo/shared";
import { currentLogContext, type Logger, since } from "../logger";

/** The newest model calls, in memory, for "model performance at a glance". */
export class ModelCallStats {
  private readonly calls: ModelCall[] = [];

  constructor(private readonly capacity = 300) {}

  record(call: ModelCall): void {
    this.calls.push(call);
    if (this.calls.length > this.capacity) this.calls.splice(0, this.calls.length - this.capacity);
  }

  /** Newest first. */
  recent(limit = 50): ModelCall[] {
    return this.calls.slice(-limit).reverse();
  }

  /** One row per provider and model, the most recently used first. */
  summary(): ModelStat[] {
    const groups = new Map<string, ModelCall[]>();
    for (const c of this.calls) {
      const key = `${c.providerId}\u0000${c.model}`;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    const rows: ModelStat[] = [];
    for (const list of groups.values()) {
      const last = list.at(-1) as ModelCall;
      const speeds = list.map((c) => c.tokensPerSec).filter((v): v is number => v !== null);
      const ttfts = list
        .map((c) => c.ttftMs)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      const lastError = [...list].reverse().find((c) => !c.ok)?.error ?? null;
      rows.push({
        providerId: last.providerId,
        model: last.model,
        calls: list.length,
        errors: list.filter((c) => !c.ok).length,
        avgTokensPerSec: speeds.length ? round1(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
        medianTtftMs: ttfts.length ? (ttfts[Math.floor((ttfts.length - 1) / 2)] ?? null) : null,
        lastAt: last.ts,
        lastError,
      });
    }
    return rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Wrap a provider so every chat call is measured and logged: time to the first chunk, total time,
 * prompt and reply tokens (when the runtime reports them), tokens per second, and errors.
 * The task, project and agent come from the log context of the caller.
 */
export function instrumentProvider(
  provider: ModelProvider,
  log: Logger,
  stats?: ModelCallStats,
): ModelProvider {
  const pull = provider.pull?.bind(provider);
  const remove = provider.remove?.bind(provider);
  return {
    id: provider.id,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    health: (signal) => provider.health(signal),
    listModels: (signal) => provider.listModels(signal),
    embed: async (model, inputs, signal) => {
      const start = performance.now();
      try {
        const out = await provider.embed(model, inputs, signal);
        log.debug("embeddings", {
          provider: provider.id,
          model,
          inputs: inputs.length,
          durationMs: since(start),
        });
        return out;
      } catch (err) {
        log.warn("embeddings failed", { provider: provider.id, model, durationMs: since(start), err });
        throw err;
      }
    },
    chat: (req) => measuredChat(provider, req, log, stats),
    ...(pull ? { pull } : {}),
    ...(remove ? { remove } : {}),
  };
}

async function* measuredChat(
  provider: ModelProvider,
  req: ChatRequest,
  log: Logger,
  stats: ModelCallStats | undefined,
): AsyncGenerator<ChatChunk> {
  const start = performance.now();
  let firstAt: number | null = null;
  let chars = 0;
  let toolCalls = 0;
  let done: Extract<ChatChunk, { type: "done" }> | null = null;
  const ctx = currentLogContext();
  const base = {
    provider: provider.id,
    providerKind: provider.kind,
    model: req.model,
    messages: req.messages.length,
    tools: req.tools?.length ?? 0,
  };
  log.debug("model call started", base);
  const finish = (ok: boolean, err?: unknown) => {
    const durationMs = since(start);
    const ttftMs = firstAt === null ? null : Math.round(firstAt - start);
    const usage = done?.usage ?? null;
    // Prefer the runtime's own generation time; otherwise the time after the first chunk.
    const genMs = usage?.durationMs ?? (firstAt === null ? null : performance.now() - firstAt);
    const tokensPerSec =
      usage && usage.completionTokens > 0 && genMs && genMs > 0
        ? Math.round((usage.completionTokens / (genMs / 1000)) * 10) / 10
        : null;
    const gw = err instanceof ModelGatewayError ? err : null;
    const cancelled = gw?.kind === "cancelled";
    const fields = {
      ...base,
      ttftMs,
      durationMs,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      tokensPerSec,
      replyChars: chars,
      toolCalls,
      finishReason: done?.finishReason ?? null,
      ...(err ? { err } : {}),
    };
    if (ok) log.info("model call", fields);
    else if (cancelled) log.debug("model call cancelled", fields);
    else log.warn("model call failed", fields);
    if (cancelled) return;
    stats?.record({
      ts: new Date().toISOString(),
      providerId: provider.id,
      providerKind: provider.kind,
      model: req.model,
      ok,
      error: ok ? null : err instanceof Error ? err.message : String(err),
      errorKind: gw?.kind ?? null,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      ttftMs,
      durationMs,
      tokensPerSec,
      projectId: typeof ctx?.projectId === "string" ? ctx.projectId : null,
      taskId: typeof ctx?.taskId === "string" ? ctx.taskId : null,
      agent: typeof ctx?.agent === "string" ? ctx.agent : null,
    });
  };
  let failed = false;
  try {
    for await (const chunk of provider.chat(req)) {
      if (firstAt === null) firstAt = performance.now();
      if (chunk.type === "text") chars += chunk.delta.length;
      else if (chunk.type === "tool_call") toolCalls++;
      else done = chunk;
      yield chunk;
    }
  } catch (err) {
    failed = true;
    finish(false, err);
    throw err;
  } finally {
    // Also runs when the caller stops reading early.
    if (!failed) finish(true);
  }
}
