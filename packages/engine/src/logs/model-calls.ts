import { type ChatChunk, type ChatRequest, ModelGatewayError, type ModelProvider } from "@depo/model-gateway";
import { COLD_LOAD_MS, type ModelCall, type ModelStat } from "@depo/shared";
import { currentLogContext, type Logger, since } from "../logger";

/** A model loaded early (warm-up), outside any chat call. */
export interface ModelLoad {
  ts: string;
  providerId: string;
  model: string;
  /** Time the runtime took; null when it did not say. */
  loadMs: number | null;
  /** The model was not in memory before. */
  cold: boolean;
}

/** How many of the newest calls decide whether a model counts as "kept loaded". */
const KEPT_LOADED_CALLS = 3;

/** The newest model calls, in memory, for "model performance at a glance". */
export class ModelCallStats {
  private readonly calls: ModelCall[] = [];
  private readonly loads: ModelLoad[] = [];

  constructor(private readonly capacity = 300) {}

  record(call: ModelCall): void {
    this.calls.push(call);
    if (this.calls.length > this.capacity) this.calls.splice(0, this.calls.length - this.capacity);
  }

  /** An early load (warm-up). Kept apart from calls so speeds and first-token times stay true. */
  recordLoad(load: ModelLoad): void {
    this.loads.push(load);
    if (this.loads.length > 100) this.loads.splice(0, this.loads.length - 100);
  }

  /** Newest first. */
  recent(limit = 50): ModelCall[] {
    return this.calls.slice(-limit).reverse();
  }

  /** One row per provider and model, the most recently used first. */
  summary(): ModelStat[] {
    const groups = new Map<string, { calls: ModelCall[]; loads: ModelLoad[] }>();
    const group = (providerId: string, model: string) => {
      const key = `${providerId}\u0000${model}`;
      let g = groups.get(key);
      if (!g) {
        g = { calls: [], loads: [] };
        groups.set(key, g);
      }
      return g;
    };
    for (const c of this.calls) group(c.providerId, c.model).calls.push(c);
    for (const l of this.loads) group(l.providerId, l.model).loads.push(l);
    const rows: ModelStat[] = [];
    for (const { calls: list, loads } of groups.values()) {
      const last = list.at(-1);
      const lastLoad = loads.at(-1);
      const lastAt =
        [last?.ts, lastLoad?.ts]
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? "";
      const speeds = list.map((c) => c.tokensPerSec).filter((v): v is number => v !== null);
      const ttfts = list
        .map((c) => c.ttftMs)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      const lastError = [...list].reverse().find((c) => !c.ok)?.error ?? null;
      // Loads: the calls that had to load the model, plus early loads.
      const coldTimes = [
        ...list.filter((c) => c.coldLoad === true).map((c) => c.loadMs ?? null),
        ...loads.filter((l) => l.cold).map((l) => l.loadMs),
      ].filter((v): v is number => v !== null);
      const coldLoads = list.filter((c) => c.coldLoad === true).length + loads.filter((l) => l.cold).length;
      const loadMsTotal =
        sum(list.map((c) => c.loadMs ?? 0)) + sum(loads.map((l) => (l.cold ? (l.loadMs ?? 0) : 0)));
      const busyMsTotal = sum(list.map((c) => c.durationMs)) + sum(loads.map((l) => l.loadMs ?? 0));
      const known = list.filter((c) => c.coldLoad === true || c.coldLoad === false);
      const keptLoaded = known.length
        ? known.slice(-KEPT_LOADED_CALLS).every((c) => c.coldLoad === false)
        : null;
      const promptSpeeds = list
        .map((c) => c.promptTokensPerSec ?? null)
        .filter((v): v is number => v !== null);
      const cached = list.map((c) => c.cachedPromptTokens).filter((v): v is number => typeof v === "number");
      const provider = last ?? lastLoad;
      rows.push({
        providerId: provider?.providerId ?? "",
        model: provider?.model ?? "",
        calls: list.length,
        errors: list.filter((c) => !c.ok).length,
        avgTokensPerSec: speeds.length ? round1(sum(speeds) / speeds.length) : null,
        medianTtftMs: ttfts.length ? (ttfts[Math.floor((ttfts.length - 1) / 2)] ?? null) : null,
        lastAt,
        lastError,
        contextLength:
          [...list].reverse().find((c) => typeof c.contextLength === "number")?.contextLength ?? null,
        coldLoads,
        medianLoadMs: median(coldTimes),
        loadMsTotal,
        busyMsTotal,
        keptLoaded,
        avgPromptTokensPerSec: promptSpeeds.length ? round1(sum(promptSpeeds) / promptSpeeds.length) : null,
        cachedPromptTokens: cached.length ? sum(cached) : null,
      });
    }
    return rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** Tokens per second, or null when either number is missing. */
function perSec(tokens: number | null | undefined, ms: number | null | undefined): number | null {
  return tokens && tokens > 0 && ms && ms > 0 ? round1(tokens / (ms / 1000)) : null;
}

/**
 * Wrap a provider so every chat call is measured and logged: time to the first chunk, total time,
 * prompt and reply tokens (when the runtime reports them), tokens per second, model load time and
 * prompt reading speed, and errors. Early loads (preload) are logged and kept too.
 * The task, project and agent come from the log context of the caller.
 */
export function instrumentProvider(
  provider: ModelProvider,
  log: Logger,
  stats?: ModelCallStats,
): ModelProvider {
  const pull = provider.pull?.bind(provider);
  const remove = provider.remove?.bind(provider);
  const preload = provider.preload?.bind(provider);
  const unload = provider.unload?.bind(provider);
  const loaded = provider.loaded?.bind(provider);
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
    ...(preload
      ? {
          preload: async (model, opts) => {
            const start = performance.now();
            const fields = {
              provider: provider.id,
              model,
              contextLength: opts?.contextLength ?? null,
              keepAlive: opts?.keepAlive ?? null,
            };
            try {
              const res = await preload(model, opts);
              const durationMs = since(start);
              const cold = (res.loadMs ?? durationMs) >= COLD_LOAD_MS;
              log.info("model loaded early", { ...fields, loadMs: res.loadMs, cold, durationMs });
              stats?.recordLoad({
                ts: new Date().toISOString(),
                providerId: provider.id,
                model,
                loadMs: res.loadMs,
                cold,
              });
              return res;
            } catch (err) {
              log.debug("early model load failed", { ...fields, durationMs: since(start), err });
              throw err;
            }
          },
        }
      : {}),
    ...(unload ? { unload } : {}),
    ...(loaded ? { loaded } : {}),
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
    contextLength: req.contextLength ?? null,
    keepAlive: req.keepAlive ?? null,
  };
  log.debug("model call started", base);
  const finish = (ok: boolean, err?: unknown) => {
    const durationMs = since(start);
    const ttftMs = firstAt === null ? null : Math.round(firstAt - start);
    const usage = done?.usage ?? null;
    // Prefer the runtime's own generation time; otherwise the time after the first chunk.
    const genMs = usage?.durationMs ?? (firstAt === null ? null : performance.now() - firstAt);
    const tokensPerSec = perSec(usage?.completionTokens, genMs);
    const loadMs = usage?.loadMs ?? null;
    const coldLoad = loadMs === null ? null : loadMs >= COLD_LOAD_MS;
    const promptMs = usage?.promptMs ?? null;
    const promptTokensPerSec = perSec(usage?.promptTokens, promptMs);
    const cachedPromptTokens = usage?.cachedPromptTokens ?? null;
    const gw = err instanceof ModelGatewayError ? err : null;
    const cancelled = gw?.kind === "cancelled";
    const fields = {
      ...base,
      ttftMs,
      durationMs,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      tokensPerSec,
      loadMs,
      coldLoad,
      promptMs,
      promptTokensPerSec,
      cachedPromptTokens,
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
      loadMs,
      coldLoad,
      promptMs,
      promptTokensPerSec,
      cachedPromptTokens,
      contextLength: req.contextLength ?? null,
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
