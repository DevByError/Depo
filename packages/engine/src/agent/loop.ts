import {
  type ChatMessage,
  type ChatResult,
  collectChat,
  ModelGatewayError,
  type ModelProvider,
  PARSE_ERROR,
  type ToolCall,
} from "@depo/model-gateway";
import { newId } from "@depo/shared";
import type { EventBus } from "../events/bus";
import { getLogger, withLogContext } from "../logger";
import type { ModelScheduler } from "../scheduler/scheduler";
import { executeTool, type ToolContext, toolDefinitions } from "../tools/index";
import { extractTextToolCalls, looksLikeToolCall, stripToolMarkup } from "./textcalls";

/** A model call may be retried this many times after a transient failure. */
const MODEL_RETRIES = 4;
/** Waits between retries grow, so a runtime that is busy (re)loading a model gets about a minute. */
const RETRY_BACKOFF = [1, 3, 8, 15];
const log = getLogger({ component: "agent" });

export type Emit = (e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) => unknown;

export interface LoopParams {
  provider: ModelProvider;
  model: string;
  contextLength: number;
  /** Includes the system prompt first. The loop appends to it. */
  history: ChatMessage[];
  /** Tools this agent may call (names). Others are refused. */
  toolNames: string[];
  ctx: ToolContext;
  maxSteps: number;
  signal: AbortSignal;
  scheduler?: ModelScheduler | undefined;
  job: { projectId: string; taskId: string; label: string };
  retryDelayMs?: number | undefined;
  emit: Emit;
  /** Save a message to the task transcript. */
  persist: (msg: ChatMessage & { isError?: boolean }) => void;
  /** Lessons learned: called around tool calls and test runs. */
  lessons?: {
    onCall(name: string, args: Record<string, unknown>): void;
    onTest(r: { passed: boolean; output: string }): string | undefined;
  };
  temperature?: number;
}

export interface LoopResult {
  finalText: string;
  aborted: boolean;
  /** Stopped because maxSteps ran out. */
  hitLimit: boolean;
  steps: number;
  lastTest: { command: string; passed: boolean } | null;
  /** Paths written or edited during the loop. */
  changed: string[];
}

/**
 * The tool loop shared by every agent: ask the model, run the tools it calls, feed back the
 * results, until it answers without a tool call. Hardened for small models (text tool calls,
 * unreadable output, copied line numbers) and it checks the tests before accepting "done".
 */
export function runAgentLoop(p: LoopParams): Promise<LoopResult> {
  // Every line logged during the loop (model calls, tools, queue) carries the task and agent.
  return withLogContext(
    { projectId: p.job.projectId, taskId: p.job.taskId, agent: p.ctx.agent },
    async () => {
      const started = performance.now();
      const res = await agentLoop(p);
      log.info("agent loop finished", {
        model: p.model,
        steps: res.steps,
        aborted: res.aborted,
        hitLimit: res.hitLimit,
        changed: res.changed.length,
        lastTest: res.lastTest?.passed ?? null,
        durationMs: Math.round(performance.now() - started),
      });
      return res;
    },
  );
}

async function agentLoop(p: LoopParams): Promise<LoopResult> {
  const { history, emit, signal } = p;
  const tools = toolDefinitions(p.toolNames, p.ctx.extraTools);
  const toolNames = tools.map((t) => t.name);
  const failures = new Map<string, number>();
  const changed = new Set<string>();
  let finalText = "";
  let steps = 0;
  let badOutputs = 0;
  // Small models often say "tests passed" when they did not, so check before accepting the end.
  let lastTest = null as { command: string; passed: boolean } | null;
  let editedSinceTest = false;
  let finishNudges = 0;

  const ctx: ToolContext = {
    ...p.ctx,
    onFileChanged: (f) => {
      changed.add(f);
      p.ctx.onFileChanged?.(f);
    },
    onTestResult: (r) => {
      lastTest = { command: r.command, passed: r.passed };
      editedSinceTest = false;
      return p.lessons?.onTest(r) ?? p.ctx.onTestResult?.(r);
    },
  };

  while (steps < p.maxSteps) {
    if (signal.aborted) break;
    steps++;
    compressHistory(history, p.contextLength);
    const messageId = newId("msg");
    // Runtimes send nothing while they read the prompt; say so, since it can take minutes.
    emit({
      type: "planning",
      text: `Waiting for ${p.model} to answer (step ${steps})`,
      details: { jobId: `wait-${p.job.taskId}`, step: steps },
      ephemeral: true,
      status: "running",
    });
    let streamed = "";
    let lastEmit = 0;
    const res = await chatWithRetry(
      p,
      {
        model: p.model,
        messages: history,
        tools,
        contextLength: p.contextLength,
        signal,
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      },
      (delta) => {
        streamed += delta;
        const now = Date.now();
        if (now - lastEmit > 150) {
          lastEmit = now;
          emit({
            type: "thinking",
            text: lastLine(streamed),
            details: { jobId: messageId, text: streamed.slice(-4000) },
            ephemeral: true,
            status: "running",
          });
        }
      },
    );
    emit({
      type: "planning",
      text: "Model answered",
      details: { jobId: `wait-${p.job.taskId}`, clear: true },
      ephemeral: true,
      status: "succeeded",
    });
    if (res === null) break; // cancelled
    if ("badOutput" in res) {
      // The runtime could not read the model's reply (usually a broken tool call). Tell the model
      // and let it try again, unless it keeps happening.
      badOutputs++;
      if (badOutputs >= 3) throw new Error(`${res.badOutput} This happened 3 times in a row.`);
      emit({ type: "retrying", text: `${res.badOutput} Asking the model to try again.`, status: "running" });
      history.push({
        role: "user",
        content:
          "Your last reply could not be read: the tool call was malformed or cut off. Reply again and make exactly one complete, valid tool call.",
      });
      continue;
    }
    badOutputs = 0;
    let calls: ToolCall[] = res.toolCalls;
    if (calls.length === 0) {
      const parsed = extractTextToolCalls(res.text, toolNames);
      calls = parsed.calls;
      if (calls.length) res.text = parsed.rest;
      else if (looksLikeToolCall(res.text, toolNames)) {
        // A tool call written as text that could not be read: not a final answer.
        badOutputs++;
        if (badOutputs >= 3)
          throw new Error("The model kept writing tool calls that could not be read. Try a larger model.");
        emit({
          type: "retrying",
          text: "The model's tool call could not be read. Asking it to try again.",
          status: "running",
        });
        history.push({ role: "assistant", content: res.text });
        history.push({
          role: "user",
          content:
            "That tool call could not be read: it is not complete, valid JSON. Make exactly one tool call, using the tool-calling format, with every bracket closed.",
        });
        continue;
      }
    }
    if (calls.length === 0) res.text = stripToolMarkup(res.text);
    const assistant: ChatMessage = {
      role: "assistant",
      content: res.text,
      ...(calls.length ? { toolCalls: calls } : {}),
    };
    history.push(assistant);
    p.persist(assistant);
    if (res.text.trim()) {
      emit({
        type: "thinking",
        text: lastLine(res.text),
        details: { jobId: messageId, text: res.text.slice(-4000) },
        status: "info",
      });
    }
    if (calls.length === 0) {
      const nudge =
        finishNudges >= 2
          ? null
          : lastTest && !lastTest.passed
            ? `The last test run (${lastTest.command}) failed, so the task is not done. Read the failure, fix the code, and run the tests again before you finish.`
            : editedSinceTest && lastTest
              ? "You changed files after the last test run. Run the tests again before you finish."
              : null;
      if (nudge) {
        finishNudges++;
        emit({ type: "retrying", text: "Checking the tests before finishing.", status: "running" });
        history.push({ role: "user", content: nudge });
        continue;
      }
      finalText = res.text.trim();
      if (lastTest && !lastTest.passed) {
        const note = `Note from Depo: the last test run (${lastTest.command}) failed. Check the changes before you approve them.`;
        finalText += `\n\n${note}`;
        p.persist({ role: "assistant", content: note });
      }
      break;
    }
    for (const call of calls) {
      if (signal.aborted) break;
      p.lessons?.onCall(call.name, (call.arguments ?? {}) as Record<string, unknown>);
      if (call.name === "edit_file" || call.name === "write_file") editedSinceTest = true;
      const result = p.toolNames.includes(call.name)
        ? await executeTool(call.name, call.arguments, ctx)
        : {
            content: `The tool "${call.name}" is not available to you. Your tools: ${p.toolNames.join(", ")}.`,
            isError: true,
          };
      let content = result.content;
      if (result.isError) {
        const key = `${call.name}:${call.rawArguments}`;
        const n = (failures.get(key) ?? 0) + 1;
        failures.set(key, n);
        if (n >= 3) content += "\nThis exact call has failed 3 times. Try a different approach.";
      }
      const toolMsg: ChatMessage = { role: "tool", toolCallId: call.id, name: call.name, content };
      history.push(toolMsg);
      p.persist({ ...toolMsg, ...(result.isError ? { isError: true } : {}) });
    }
  }

  return {
    finalText,
    aborted: signal.aborted,
    hitLimit: !signal.aborted && !finalText && steps >= p.maxSteps,
    steps,
    lastTest,
    changed: [...changed],
  };
}

async function chatWithRetry(
  p: LoopParams,
  req: Parameters<ModelProvider["chat"]>[0],
  onText: (d: string) => void,
): Promise<ChatResult | { badOutput: string } | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const call = () => collectChat(p.provider.chat(req), onText);
      return await (p.scheduler
        ? p.scheduler.run({ ...p.job, model: req.model, priority: "task" }, call, req.signal)
        : call());
    } catch (err) {
      if (err instanceof ModelGatewayError && err.kind === "cancelled") return null;
      if (isBadModelOutput(err)) {
        // Sampling is random, so a plain retry often succeeds; after that, the loop nudges the model.
        log.warn("model output could not be read", { model: req.model, attempt: attempt + 1, err });
        if (attempt < 1) continue;
        return { badOutput: (err as Error).message };
      }
      const transient =
        err instanceof ModelGatewayError &&
        (err.kind === "timeout" ||
          err.kind === "unreachable" ||
          (err.kind === "http" && (err.status ?? 0) >= 500));
      if (!transient || attempt >= MODEL_RETRIES) {
        log.error("model call gave up", { model: req.model, attempts: attempt + 1, err });
        throw err;
      }
      log.warn("model call retry", { model: req.model, attempt: attempt + 1, of: MODEL_RETRIES, err });
      p.emit({
        type: "retrying",
        text: `${(err as Error).message} Retrying…`,
        details: { attempt: attempt + 1 },
        status: "running",
      });
      await Bun.sleep(p.retryDelayMs ?? (RETRY_BACKOFF[attempt] ?? 15) * 1000);
      if (req.signal?.aborted) return null;
    }
  }
}

export function lastLine(s: string): string {
  const lines = s
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  return (lines.at(-1) ?? "").slice(0, 200);
}

/**
 * Keep the conversation inside the model's context window: old tool outputs are trimmed first
 * (the model can re-read files), then the oldest exchanges after the first request are dropped.
 */
export function compressHistory(history: ChatMessage[], contextLength: number): void {
  const budget = contextLength * 0.7 * 3.5; // ~3.5 characters per token
  const size = () =>
    history.reduce(
      (n, m) =>
        n + m.content.length + (m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0),
      0,
    );
  if (size() <= budget) return;
  const keepTail = 6;
  for (let i = 0; i < history.length - keepTail && size() > budget; i++) {
    const m = history[i];
    if (m?.role === "tool" && m.content.length > 400) {
      history[i] = {
        ...m,
        content: `${m.content.slice(0, 300)}\n[older output trimmed to save context; read the file again if needed]`,
      };
    }
  }
  // Still too large: drop whole assistant+tool exchanges after the system prompt and first user message.
  while (size() > budget && history.length > keepTail + 2) {
    const idx = history.findIndex((m, i) => i >= 2 && m.role === "assistant");
    if (idx < 0 || idx >= history.length - keepTail) break;
    let end = idx + 1;
    while (end < history.length && history[end]?.role === "tool") end++;
    history.splice(idx, end - idx);
  }
}

/** The runtime rejected the model's own output (e.g. a malformed tool call), as opposed to failing. */
export function isBadModelOutput(err: unknown): boolean {
  if (!(err instanceof ModelGatewayError)) return false;
  if (err.kind === "invalid_output") return true;
  return err.kind === "http" && PARSE_ERROR.test(`${err.message} ${err.detail ?? ""}`);
}
