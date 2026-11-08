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
import { normalizeArgs } from "../tools/args";
import { executeTool, type ToolContext, toolDefinitions } from "../tools/index";
import { aliasFor, aliasNote } from "./aliases";
import { blockCalls, blockResults } from "./blocks";
import { codeBlocks, dumpInProgress, dumpNudge, isCodeDump } from "./codedump";
import { type Repetition, RepetitionGuard } from "./repetition";
import {
  extractTextToolCalls,
  firstCallGroupEnd,
  firstTextCallEnd,
  inventsToolResult,
  looksLikeToolCall,
  stripToolMarkup,
  textCallProblem,
  unknownToolCalls,
  withoutInventedResults,
  withoutStrayResultTag,
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
/** Replies stopped for pasting code instead of saving it, per run, before Depo lets them finish. */
const MAX_DUMP_CUTS = 3;
/**
 * Replies in a row with no tool call Depo could run (broken JSON, made-up tools, unfinished
 * blocks) before the task stops. A larger model, when there is one, takes the last tries.
 */
const MAX_UNREADABLE = 4;
const STEP_UP_AT = 3;
const STEP_UP_TRIES = 2;
/** Sampling after an unreadable reply: careful, so the next call comes out well formed. */
const CAREFUL_TEMPERATURE = 0.2;
/** What stands in the history for a reply that could not be read (small models copy their own broken calls). */
export const BROKEN_STUB = "(I wrote a tool call that Depo could not read, so nothing ran.)";
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
  /**
   * A larger installed model that takes a step the model keeps failing (no call it writes can be
   * read). Depo goes back to the model as soon as a call runs.
   */
  stepUp?: { model: string } | undefined;
  /** The model was taught file blocks (small models): nudges point to them rather than to JSON. */
  fileBlocks?: boolean;
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
  // The model answering now: a larger one takes over while the model is stuck on a step.
  let model = p.model;
  let temperature = p.temperature;
  // Small models often say "tests passed" when they did not, so check before accepting the end.
  let lastTest = null as { command: string; passed: boolean } | null;
  let editedSinceTest = false;
  let finishNudges = 0;
  let doItNudges = 0;
  let madeUpResults = 0;
  // Replies in a row whose tool calls could not be read or named a tool that does not exist.
  let unreadable = 0;
  let dumpCuts = 0;
  let finalDumps = 0;
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
      text: `Waiting for ${model} to answer (step ${steps})`,
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
    // A reply that pastes whole files as text (no tool call) is stopped once that is clear.
    const dump = { checkedAt: 0, cut: false };
    const stop = new AbortController();
    const relay = () => stop.abort();
    signal.addEventListener("abort", relay, { once: true });
    let res: Awaited<ReturnType<typeof chatWithRetry>>;
    try {
      res = await chatWithRetry(
        p,
        {
          model,
          messages: history,
          tools,
          contextLength: runtime.contextLength,
          signal: stop.signal,
          maxTokens: p.maxReplyTokens ?? MAX_REPLY_TOKENS,
          ...(temperature !== undefined ? { temperature } : {}),
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
          if (
            canEdit &&
            dumpCuts < MAX_DUMP_CUTS &&
            !loop.found &&
            !early.cut &&
            !dump.cut &&
            early.end < 0 &&
            streamed.length - dump.checkedAt >= 200
          ) {
            dump.checkedAt = streamed.length;
            if (dumpInProgress(streamed, toolNames, ctx.root)) {
              dump.cut = true;
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
        model,
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
        model,
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
    let dumped = false;
    if (res === null && dump.cut && !signal.aborted) {
      dumpCuts++;
      dumped = true;
      log.warn("model reply pasted code instead of saving it", { model, chars: streamed.length });
      res = { text: streamed, toolCalls: [], finishReason: "unknown", usage: null };
    }
    if (res === null) break; // cancelled
    /**
     * A reply with no call Depo could run, though the model meant to make one. The broken reply is
     * not shown to the model again (small models copy it); the advice changes with each try, the
     * next reply is sampled carefully, and a larger model takes the last tries when there is one.
     */
    const unreadableReply = (o: { event: string; problem: string; tool: string | null; final: string }) => {
      unreadable++;
      const limit = p.stepUp ? STEP_UP_AT + STEP_UP_TRIES : MAX_UNREADABLE;
      if (unreadable >= limit) throw new Error(o.final);
      history.push({ role: "assistant", content: BROKEN_STUB });
      if (temperature === undefined || temperature > CAREFUL_TEMPERATURE) temperature = CAREFUL_TEMPERATURE;
      emit({ type: "retrying", text: o.event, status: "running" });
      if (p.stepUp && unreadable >= STEP_UP_AT && model !== p.stepUp.model) {
        model = p.stepUp.model;
        log.warn("stepping up to a larger model", { from: p.model, to: model });
        emit({
          type: "retrying",
          text: `${p.model} is stuck on this step, so Depo asked ${model} to do it. Depo goes back to ${p.model} once a call runs.`,
          details: { from: p.model, to: model },
          status: "running",
        });
      }
      history.push({
        role: "user",
        content: `${o.problem} ${retryAdvice(o.tool, unreadable, !!p.fileBlocks)}`,
      });
    };
    if ("badOutput" in res) {
      // The runtime could not read the model's reply (usually a broken tool call).
      unreadableReply({
        event: `${res.badOutput} Asking the model to try again.`,
        problem: "Your last reply could not be read: the tool call was malformed or cut off, so nothing ran.",
        tool: null,
        final: `${res.badOutput} This kept happening.`,
      });
      continue;
    }
    if (!repeated) loops = 0;
    res.text = withoutStrayResultTag(res.text);
    // The reply as the model wrote it: kept in the history when its file blocks become calls.
    const written = res.text;
    let calls: ToolCall[] = res.toolCalls;
    // Calls Depo ran under their real name (the model made up "create_file"): id → that name.
    let renamed: Record<string, string> = {};
    if (calls.length) ({ calls, renamed } = withAliases(calls, toolNames, ctx.root));
    if (calls.length === 0 && !dumped) {
      const parsed = extractTextToolCalls(res.text, toolNames, ctx.root);
      calls = parsed.calls;
      renamed = parsed.renamed;
      if (calls.length) res.text = parsed.rest;
    }
    // File blocks (a new file under its path, SEARCH/REPLACE edits): files without JSON.
    let fromBlocks = false;
    let unfinishedBlocks = 0;
    let blockExisting: string[] = [];
    if (canEdit) {
      // New files from labelled code: always for a model taught file blocks; for others only in a
      // reply Depo stopped for pasting code, or a code answer while nothing changed yet (as before).
      const newFiles = !!p.fileBlocks || dumped || (changed.size === 0 && isCodeDump(res.text));
      const b = blockCalls(res.text, ctx.root, toolNames, { newFiles });
      unfinishedBlocks = b.unfinished;
      blockExisting = b.existing;
      if (b.calls.length) {
        calls = [...b.calls, ...calls];
        res.text = b.rest;
        fromBlocks = true;
      }
    }
    if (calls.length === 0 && !dumped) {
      if (repeated || res.finishReason === "length") {
        // Cut off with no tool call: not a final answer. Show the model where it stopped.
        history.push({ role: "assistant", content: res.text });
        history.push({
          role: "user",
          content: repeated
            ? "Depo stopped your reply because it kept repeating the same lines. Do not repeat yourself. Make one tool call, or give your final answer in a few sentences."
            : "Your reply was too long and was cut off. Make one tool call at a time, write big files in parts, and keep the final answer short.",
        });
        continue;
      }
      const unknown = unknownToolCalls(res.text, toolNames);
      if (unknown.length) {
        // Calls to tools that do not exist ("add_table"): nothing ran, so this is not an answer.
        unreadableReply({
          event: `The model called ${unknown.length === 1 ? "a tool that does not exist" : "tools that do not exist"} (${unknown.join(", ")}), so nothing ran. Asking it to use its real tools.`,
          problem: `${unknown.map((n) => `"${n}"`).join(", ")} ${unknown.length === 1 ? "is not a tool" : "are not tools"}, so nothing ran and nothing changed. Your tools are: ${toolNames.join(", ")}. To create a file use write_file, to add to the end of a file (a new table in schema.sql) append_file, to change a file edit_file${p.fileBlocks ? ", or write file blocks" : ""}.`,
          tool: null,
          final: `The model kept calling tools that do not exist (${unknown.join(", ")}). Try a larger model.`,
        });
        continue;
      }
      if (looksLikeToolCall(res.text, toolNames)) {
        // A tool call written as text that could not be read: not a final answer. The count only
        // goes back to zero when a call runs, so the same broken call cannot repeat for hours.
        const why = textCallProblem(res.text, toolNames);
        unreadableReply({
          event: `The model's tool call could not be read${why ? ` (${why})` : ""}. Asking it to try again.`,
          problem: `Your tool call could not be read: it is not valid JSON${why ? ` (${why})` : ""}, so nothing ran.`,
          tool: toolNames.find((n) => res.text.includes(`"${n}"`)) ?? null,
          final: "The model kept writing tool calls that could not be read. Try a larger model.",
        });
        continue;
      }
      if (unfinishedBlocks) {
        unreadableReply({
          event:
            "The model's file block was not finished, so nothing was saved. Asking it to write it again.",
          problem:
            "Your SEARCH/REPLACE block was not finished (or had no path line above it), so nothing was saved. A block needs its path on the line above, then <<<<<<< SEARCH, the exact old lines, a line =======, the new lines, and a line >>>>>>> REPLACE.",
          tool: "edit_file",
          final: "The model kept writing file blocks that were not finished. Try a larger model.",
        });
        continue;
      }
    }
    if (calls.length) unreadable = 0;
    if (calls.length === 0) res.text = stripToolMarkup(res.text);
    // Asked twice already: keep the model's own words and drop the results it made up.
    if (calls.length === 0 && madeUpResults >= 2 && inventsToolResult(res.text))
      res.text =
        withoutInventedResults(res.text) ||
        "The model could not finish this step with its tools. The work so far is ready for review.";
    // Code pasted into the reply instead of saved: the new files it labels were saved as blocks
    // above; ask for tools (or blocks) for the rest.
    let dumpNote: string | null = null;
    if (
      canEdit &&
      (dumped || (calls.length === 0 && changed.size === 0 && finalDumps < 2 && isCodeDump(res.text)))
    ) {
      if (!dumped) finalDumps++;
      const saved = calls
        .filter((c) => c.name === "write_file" && c.id.startsWith("block_"))
        .map((c) => String((c.arguments as { path?: unknown }).path));
      const firstBlock = codeBlocks(res.text)[0]?.start ?? res.text.length;
      res.text = res.text.slice(0, firstBlock).trim();
      dumpNote = dumpNudge(saved, blockExisting, dumped, !!p.fileBlocks);
      emit({
        type: "retrying",
        text: `The model ${dumped ? "was pasting" : "pasted"} code into its reply instead of saving files${dumped ? ", so Depo stopped it" : ""}. ${
          saved.length
            ? `Depo saved the ${saved.length === 1 ? "new file" : `${saved.length} new files`} it named (${saved.join(", ")}) and asked it to use its tools.`
            : "Asking it to save files with its tools."
        }`,
        status: "running",
      });
    }
    calls = uniqueCalls(calls).map((c) => {
      const args = normalizeArgs(c.name, c.arguments, ctx.root);
      return args === c.arguments ? c : { ...c, arguments: args, rawArguments: JSON.stringify(args) };
    });
    const assistant: ChatMessage = {
      role: "assistant",
      content: res.text,
      ...(calls.length ? { toolCalls: calls } : {}),
    };
    // File blocks stay in the history as the model wrote them, so it keeps writing blocks (shown
    // as JSON calls, a small model goes back to JSON and breaks it); the transcript keeps the calls.
    // A reply Depo stopped for pasting code keeps only its words.
    const asWritten = fromBlocks && !dumped;
    history.push(asWritten ? { role: "assistant", content: written } : assistant);
    p.persist(assistant);
    if (res.text.trim()) {
      emit({
        type: "thinking",
        text: lastLine(res.text),
        details: { jobId: messageId, text: res.text.slice(-4000) },
        status: "info",
      });
    }
    if (calls.length === 0 && dumpNote) {
      history.push({ role: "user", content: dumpNote });
      continue;
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
    const blockOut: { call: ToolCall; content: string; isError: boolean }[] = [];
    let ran = 0;
    for (const call of calls) {
      if (signal.aborted) break;
      p.lessons?.onCall(call.name, (call.arguments ?? {}) as Record<string, unknown>);
      if (call.name === "edit_file" || call.name === "write_file" || call.name === "append_file")
        editedSinceTest = true;
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
      if (!result.isError) ran++;
      let content = result.content;
      const madeUp = renamed[call.id];
      if (madeUp) content = `${aliasNote(madeUp, call.name)}\n${content}`;
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
      if (asWritten) blockOut.push({ call, content, isError: result.isError });
      else history.push(toolMsg);
      p.persist({ ...toolMsg, ...(result.isError ? { isError: true } : {}) });
    }
    if (asWritten)
      history.push({
        role: "user",
        content:
          blockResults(blockOut) +
          (unfinishedBlocks
            ? "\nOne of your SEARCH/REPLACE blocks was not finished, so it was not saved: write it again in full."
            : ""),
      });
    // A call ran: the stuck step is over, so the model (and its sampling) are the owner's again.
    if (ran > 0 && model !== p.model) {
      emit({
        type: "retrying",
        text: `${model} got past the step; Depo goes back to ${p.model}.`,
        details: { from: model, to: p.model },
        status: "running",
      });
      model = p.model;
    }
    if (ran > 0) temperature = p.temperature;
    if (dumpNote) history.push({ role: "user", content: dumpNote });
    else if (repeated)
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

/** Native calls to made-up tools that clearly mean a real one, renamed (id → the made-up name). */
function withAliases(
  calls: ToolCall[],
  toolNames: string[],
  root: string,
): { calls: ToolCall[]; renamed: Record<string, string> } {
  const known = new Set(toolNames);
  const renamed: Record<string, string> = {};
  const out = calls.map((c) => {
    if (known.has(c.name)) return c;
    const a = aliasFor(c.name, c.arguments, known, root);
    if (!a) return c;
    renamed[c.id] = c.name;
    return { ...c, name: a.name, arguments: a.args, rawArguments: JSON.stringify(a.args) };
  });
  return { calls: out, renamed };
}

const FILE_TOOLS = new Set(["write_file", "edit_file", "append_file"]);

/** Correct calls to copy, in the format Qwen-style models are trained on. */
const EXAMPLES: Record<string, Record<string, unknown>> = {
  read_file: { path: "be/src/app.ts" },
  edit_file: { path: "be/src/app.ts", edits: [{ search: "exact old line", replace: "new line" }] },
  write_file: { path: "be/src/new.ts", content: "line one\nline two\n" },
  append_file: { path: "be/schema.sql", content: "CREATE TABLE IF NOT EXISTS notes (id INT PRIMARY KEY);\n" },
  run_command: { command: "bun test", cwd: "be" },
};

function exampleCall(tool: string | null): string {
  const name = tool && EXAMPLES[tool] ? tool : "read_file";
  return `<tool_call>\n${JSON.stringify({ name, arguments: EXAMPLES[name] })}\n</tool_call>`;
}

/**
 * What the model is asked to do after its reply could not be read, different on each try: the
 * right shape first (file blocks for code when it was taught them), then a smaller step, then
 * the simplest step there is.
 */
export function retryAdvice(tool: string | null, attempt: number, blocks: boolean): string {
  const fileTool = !!tool && FILE_TOOLS.has(tool);
  if (attempt <= 1) {
    if (blocks && fileTool)
      return "Write the change as a file block instead of JSON: the file's path on one line, then a code block. For a new file the block holds the whole file; to change a file it holds <<<<<<< SEARCH, a few exact lines from the file, =======, the new lines, >>>>>>> REPLACE (leave SEARCH empty to add to the end). Do not repeat the same call.";
    return `Write one complete call, with every bracket closed and every " inside a text value written as \\". For example:\n${exampleCall(tool)}\nDo not repeat the same call unchanged.`;
  }
  if (attempt === 2)
    return blocks
      ? "Make a smaller step. To change code, use a file block (path line, then SEARCH/REPLACE with only two or three exact lines in SEARCH). For anything else make one tool call with short arguments."
      : `Make a smaller step: one call with short arguments. With edit_file, put only two or three exact lines in "search". For example:\n${exampleCall(tool)}`;
  return `Start with the simplest step: read the file you want to change, for example:\n${exampleCall("read_file")}`;
}

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
      // A hung model process stays hung: unloading it makes Ollama start a fresh one for the retry.
      if (fall === "crashed" && p.provider.unload)
        await p.provider.unload(req.model, AbortSignal.timeout(15_000)).catch((e: unknown) => {
          log.warn("could not unload the crashed model", { model: req.model, err: e });
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
    } else if (m?.role === "assistant" && i >= 2 && m.content.length > 1500) {
      // An old reply with file blocks: the files are saved, the copy in the history is not needed.
      history[i] = { ...m, content: `${m.content.slice(0, 300)}\n[older reply trimmed to save context]` };
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
