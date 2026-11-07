import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
import { fallOf, smallerContext, waitForRuntime } from "../models/revive";
import type { ModelScheduler } from "../scheduler/scheduler";
import { executeTool, type ToolContext, toolDefinitions } from "../tools/index";
import { type Repetition, RepetitionGuard } from "./repetition";
import {
  extractTextToolCalls,
  firstCallGroupEnd,
  firstTextCallEnd,
  inventsToolResult,
  looksLikeToolCall,
  stripToolMarkup,
  withoutInventedResults,
} from "./textcalls";

/** A model call may be retried this many times after a transient failure. */
const MODEL_RETRIES = 4;
/** Waits between retries grow, so a runtime that is busy (re)loading a model gets about a minute. */
const RETRY_BACKOFF = [1, 3, 8, 15];
/**
 * Longest reply one step may write, in tokens: room for a big file in a tool call, but a model
 * that rambles is stopped (Ollama's own default is no limit at all).
 */
export const MAX_REPLY_TOKENS = 8192;
/** Replies stopped for repeating themselves, in a row, before the task gives up. */
const MAX_LOOPS = 3;
/** Text allowed after a complete tool call written as text before the reply is stopped. */
const AFTER_CALL_CHARS = 400;
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
  /** Longest reply per step in tokens (default MAX_REPLY_TOKENS). */
  maxReplyTokens?: number;
  /**
   * Steering: notes from the owner that arrived since the last call, as messages to add. Asked
   * only between steps (before each model call, and before a final answer is accepted).
   */
  inbox?: () => ChatMessage[];
  /**
   * Called when the model says it is done (after the test checks): Depo runs the work. `retry`
   * sends the problems back to the model; `append` adds lines to the final answer.
   */
  beforeFinish?: (o: { changed: string[] }) => Promise<{ retry: string } | { append: string } | null>;
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
  // Looks the model already made since the last change (small models re-read the same file).
  const looks = new Map<string, number>();
  // Edits already made, with the file as they left it: the same edit on that file again only adds a copy.
  const edits = new Map<string, string>();
  const changed = new Set<string>();
  let finalText = "";
  let steps = 0;
  let badOutputs = 0;
  // Small models often say "tests passed" when they did not, so check before accepting the end.
  let lastTest = null as { command: string; passed: boolean } | null;
  let editedSinceTest = false;
  let finishNudges = 0;
  let doItNudges = 0;
  let madeUpResults = 0;
  let loops = 0;
  const canEdit = p.toolNames.includes("write_file") || p.toolNames.includes("edit_file");
  // Lowered when the runtime crashes twice (a context too big for the GPU's memory).
  const runtime = { contextLength: p.contextLength, crashes: 0 };

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
    // A step boundary: the previous tool calls have all finished, so the owner's notes fit here.
    for (const note of p.inbox?.() ?? []) history.push(note);
    compressHistory(history, runtime.contextLength);
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
    // A reply that starts repeating itself is stopped here, without cancelling the task.
    const guard = new RepetitionGuard();
    const loop: { found: Repetition | null } = { found: null };
    // A reply that goes on after a complete tool call written as text (inventing the result,
    // then the next steps) is stopped there: the call runs and the model gets the real result.
    const early = { end: -1, checkedAt: 0, cut: false };
    const stop = new AbortController();
    const relay = () => stop.abort();
    signal.addEventListener("abort", relay, { once: true });
    let res: Awaited<ReturnType<typeof chatWithRetry>>;
    try {
      res = await chatWithRetry(
        p,
        {
          model: p.model,
          messages: history,
          tools,
          contextLength: runtime.contextLength,
          signal: stop.signal,
          maxTokens: p.maxReplyTokens ?? MAX_REPLY_TOKENS,
          ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        },
        (delta) => {
          streamed += delta;
          if (!loop.found) {
            loop.found = guard.check(streamed);
            if (loop.found) stop.abort();
          }
          if (!loop.found && !early.cut && streamed.length - early.checkedAt >= 80) {
            early.checkedAt = streamed.length;
            if (early.end < 0) early.end = firstTextCallEnd(streamed, toolNames);
            if (early.end >= 0 && streamed.length - early.end > AFTER_CALL_CHARS) {
              early.cut = true;
              stop.abort();
            }
          }
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
        runtime,
      );
    } finally {
      signal.removeEventListener("abort", relay);
    }
    emit({
      type: "planning",
      text: "Model answered",
      details: { jobId: `wait-${p.job.taskId}`, clear: true },
      ephemeral: true,
      status: "succeeded",
    });
    let repeated = false;
    if (res === null && loop.found && !signal.aborted) {
      // Keep what came before the loop and one copy of the repeated part, then carry on.
      loops++;
      repeated = true;
      log.warn("model reply repeated itself", {
        model: p.model,
        times: loop.found.times,
        chars: streamed.length,
      });
      if (loops >= MAX_LOOPS)
        throw new Error(
          `The model kept repeating the same lines (${MAX_LOOPS} replies stopped). Try a larger model, or ask for a smaller step.`,
        );
      emit({
        type: "retrying",
        text: "The model started repeating itself, so Depo stopped that reply.",
        details: { repeated: loop.found.unit.slice(0, 400), times: loop.found.times },
        status: "running",
      });
      res = { text: streamed.slice(0, loop.found.keep), toolCalls: [], finishReason: "unknown", usage: null };
    }
    let cutAfterCall = false;
    if (res === null && early.cut && !signal.aborted) {
      cutAfterCall = true;
      // Keep the first group of calls (never a half-written one, nor the steps it went on to invent).
      const cut = Math.max(firstCallGroupEnd(streamed, toolNames), early.end);
      const after = streamed.slice(cut);
      log.warn("model reply went on after a tool call", {
        model: p.model,
        chars: streamed.length,
        inventedResult: /<tool_(response|result)>/i.test(after),
      });
      emit({
        type: "retrying",
        text: "The model kept writing after its tool call (making up the result), so Depo stopped it there and ran the call.",
        details: { after: after.slice(0, 400) },
        status: "running",
      });
      res = { text: streamed.slice(0, cut), toolCalls: [], finishReason: "unknown", usage: null };
    }
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
    if (!repeated) loops = 0;
    let calls: ToolCall[] = res.toolCalls;
    if (calls.length === 0) {
      const parsed = extractTextToolCalls(res.text, toolNames);
      calls = parsed.calls;
      if (calls.length) res.text = parsed.rest;
      else if (repeated || res.finishReason === "length") {
        // Cut off with no tool call: not a final answer. Show the model where it stopped.
        history.push({ role: "assistant", content: res.text });
        history.push({
          role: "user",
          content: repeated
            ? "Depo stopped your reply because it kept repeating the same lines. Do not repeat yourself. Make one tool call, or give your final answer in a few sentences."
            : "Your reply was too long and was cut off. Make one tool call at a time, write big files in parts, and keep the final answer short.",
        });
        continue;
      } else if (looksLikeToolCall(res.text, toolNames)) {
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
    // Asked twice already: keep the model's own words and drop the results it made up.
    if (calls.length === 0 && madeUpResults >= 2 && inventsToolResult(res.text))
      res.text =
        withoutInventedResults(res.text) ||
        "The model could not finish this step with its tools. The work so far is ready for review.";
    calls = uniqueCalls(calls);
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
      // A note arrived while the model wrote its answer: read it before finishing.
      const notes = steps < p.maxSteps ? (p.inbox?.() ?? []) : [];
      if (notes.length > 0) {
        history.push(...notes);
        continue;
      }
      // A reply made of a tool result the model wrote itself is not an answer.
      if (madeUpResults < 2 && inventsToolResult(res.text)) {
        madeUpResults++;
        emit({
          type: "retrying",
          text: "The model wrote a tool result itself instead of calling a tool. Asking it to call the tool.",
          status: "running",
        });
        history.push({
          role: "user",
          content:
            "You wrote a <tool_response> yourself. Only Depo writes tool results, after you call a tool. Call the tool you need (for example list_dir or read_file) and wait for its result, or give your final answer in your own words.",
        });
        continue;
      }
      // Small models often hand the owner a list of steps instead of doing them.
      if (canEdit && doItNudges < 2 && describesStepsForOwner(res.text, changed.size)) {
        doItNudges++;
        emit({
          type: "retrying",
          text: "The model described steps instead of doing them. Asking it to do the work.",
          status: "running",
        });
        history.push({
          role: "user",
          content:
            "Do not tell the owner what to do: do it yourself with your tools. Create every file with write_file, run installs, builds and tests with run_command (set cwd to run in a sub-folder such as fe or be), and fix what fails. Finish only when the work is built and checked, then say briefly what you did.",
        });
        continue;
      }
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
      let appended = "";
      if (p.beforeFinish && !signal.aborted) {
        const r = await p.beforeFinish({ changed: [...changed] });
        if (signal.aborted) break;
        if (r && "retry" in r && steps < p.maxSteps) {
          emit({
            type: "retrying",
            text: "Depo ran the app and found problems. Asking the model to fix them.",
            status: "running",
          });
          history.push({ role: "user", content: r.retry });
          p.persist({ role: "user", content: r.retry });
          continue;
        }
        if (r && "append" in r) appended = r.append;
      }
      finalText = res.text.trim();
      if (appended) {
        finalText += `\n\n${appended}`;
        p.persist({ role: "assistant", content: appended });
      }
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
      const editKey =
        call.name === "edit_file" ? call.rawArguments || JSON.stringify(call.arguments ?? null) : null;
      const editPath = editKey ? fileOf(ctx.root, call.arguments) : null;
      const again = !!editKey && !!editPath && edits.get(editKey) === fileHash(editPath);
      if (again)
        emit({
          type: "retrying",
          text: "The model made the same edit again; the file already has it, so Depo skipped it.",
          status: "running",
        });
      const result = again
        ? {
            content:
              "Nothing changed: you already made this exact edit and the file still has it. Do not make it again. If the request is done, give your final answer; otherwise make the next, different change.",
            isError: false,
          }
        : p.toolNames.includes(call.name)
          ? await executeTool(call.name, call.arguments, ctx)
          : {
              content: `The tool "${call.name}" is not available to you. Your tools: ${p.toolNames.join(", ")}.`,
              isError: true,
            };
      if (editKey && editPath && !again && !result.isError) edits.set(editKey, fileHash(editPath));
      let content = result.content;
      if (!LOOKS.has(call.name)) {
        if (!again) looks.clear();
      } else if (!result.isError) {
        const key = `${call.name}:${call.rawArguments || JSON.stringify(call.arguments ?? null)}`;
        const n = (looks.get(key) ?? 0) + 1;
        looks.set(key, n);
        if (n === 2) content += `\n\n${SAME_LOOK}`;
        else if (n > 2)
          content = `You made this exact call ${n} times and nothing changed since; the result is the same as before. ${SAME_LOOK}`;
      }
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
    if (repeated)
      history.push({
        role: "user",
        content:
          "Depo stopped your last reply because it kept repeating the same tool calls. Each call above ran once; read the results. Make one call at a time and never repeat a call.",
      });
    else if (cutAfterCall)
      history.push({
        role: "user",
        content:
          "Depo stopped your last reply after your tool call: you went on to write its result and the next steps yourself. The real result is above. Make one tool call at a time, then wait for its result.",
      });
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

/**
 * A final answer that hands the work to the owner ("Create a file with the following content",
 * "Navigate to fe and run…") instead of doing it.
 */
export function describesStepsForOwner(text: string, changedFiles: number): boolean {
  const codeInText =
    /\b(create|add|make) (a|an|the|this) [`'"]?[\w./-]+[`'"]? file\b[^\n]*\b(with|containing)\b|\bwith the following (content|code)\b/i.test(
      text,
    );
  if (codeInText) return true;
  if (changedFiles > 0) return false;
  return /\b(navigate to|open a terminal|run the following|follow these steps|here are the steps|you can (now )?(run|create|start|add|use)|initiali[sz]e (a|the) new|you (will )?need to (run|create|install))\b/i.test(
    text,
  );
}

/** The file an edit_file call names, inside the copy. */
function fileOf(root: string, args: unknown): string | null {
  const rel = (args as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || !rel) return null;
  const abs = path.resolve(root, rel);
  return abs.startsWith(path.resolve(root)) ? abs : null;
}

function fileHash(abs: string): string {
  try {
    return createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return "";
  }
}

/** Tools that only look; any other call (an edit, a command) may change what they show. */
const LOOKS = new Set([
  "read_file",
  "list_dir",
  "find_files",
  "search",
  "repo_map",
  "find_symbol",
  "semantic_search",
  "git_status",
  "git_diff",
  "read_playbook",
  "bb_read",
]);

const SAME_LOOK =
  "Note from Depo: you already made this exact call and nothing has changed since. Do not make it again: use the result you have. Make your change now (edit_file or write_file), or give your final answer.";

/** The same call twice in one reply (same tool, same arguments) runs once. */
export function uniqueCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = `${c.name}\u0000${c.rawArguments || JSON.stringify(c.arguments ?? null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function chatWithRetry(
  p: LoopParams,
  req: Parameters<ModelProvider["chat"]>[0],
  onText: (d: string) => void,
  runtime: { contextLength: number; crashes: number } = { contextLength: req.contextLength ?? 0, crashes: 0 },
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
      const fall = fallOf(err);
      if (fall === "dropped" || fall === "crashed") runtime.crashes++;
      // A second crash: ask for half the context, so the model fits in the GPU's memory.
      if (runtime.crashes >= 2 && runtime.contextLength > 4096) {
        const smaller = smallerContext(runtime.contextLength);
        if (smaller < runtime.contextLength) {
          log.warn("smaller context after runtime crashes", { from: runtime.contextLength, to: smaller });
          runtime.contextLength = smaller;
          req.contextLength = smaller;
          compressHistory(req.messages, smaller);
          runtime.crashes = 0;
          p.emit({
            type: "retrying",
            text: `The model runtime crashed twice, so Depo now asks for a smaller context (${smaller.toLocaleString("en-US")} tokens).`,
            details: { contextLength: smaller },
            status: "running",
          });
        }
      }
      p.emit({
        type: "retrying",
        text: `${(err as Error).message} ${fall ? "Waiting for it to answer again, then retrying…" : "Retrying…"}`,
        details: { attempt: attempt + 1, ...(fall ? { fall } : {}) },
        status: "running",
      });
      if (fall && p.retryDelayMs === undefined) {
        const back = await waitForRuntime(p.provider, { ...(req.signal ? { signal: req.signal } : {}) });
        if (!back && !req.signal?.aborted)
          log.warn("model runtime did not come back in time", { model: req.model });
      } else await Bun.sleep(p.retryDelayMs ?? (RETRY_BACKOFF[attempt] ?? 15) * 1000);
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
