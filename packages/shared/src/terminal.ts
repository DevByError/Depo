import { z } from "zod";

/**
 * Terminal: the owner runs one command at a time in the project folder or in a task's private
 * copy. Commands go through the command policy and run contained, like agent commands. There is
 * no keyboard input: a command that waits for input gets end-of-file.
 */

export const TerminalStreamSchema = z.enum(["out", "err", "depo"]);
export type TerminalStream = z.infer<typeof TerminalStreamSchema>;

/** Colours the program gave a line (ANSI codes), mapped to theme tones. */
export const TerminalToneSchema = z.enum(["danger", "warning", "success", "info", "muted"]);
export type TerminalTone = z.infer<typeof TerminalToneSchema>;

export const TerminalLineSchema = z.object({
  seq: z.number().int(),
  /** `out` and `err` come from the command; `depo` lines are Depo's own notes. */
  stream: TerminalStreamSchema,
  /** Colour codes removed, secrets redacted. */
  text: z.string(),
  tone: TerminalToneSchema.optional(),
});
export type TerminalLine = z.infer<typeof TerminalLineSchema>;

export const TerminalRunStateSchema = z.enum(["running", "succeeded", "failed", "stopped", "timed_out"]);
export type TerminalRunState = z.infer<typeof TerminalRunStateSchema>;

export const TerminalRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Set when the command ran in a task's private copy instead of the project folder. */
  taskId: z.string().nullable(),
  /** Where it ran, in plain words: "Your project" or the task's title. */
  target: z.string(),
  command: z.string(),
  /** What the command policy says it is: test, build, lint, install, inspect, … */
  category: z.string(),
  state: TerminalRunStateSchema,
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  /** Lines of output so far. */
  lines: z.number().int(),
});
export type TerminalRun = z.infer<typeof TerminalRunSchema>;

/** Details of a `terminal_output` event: new lines of a run, and the run itself when it changed. */
export const TerminalOutputDetailsSchema = z.object({
  runId: z.string(),
  lines: z.array(TerminalLineSchema),
  run: TerminalRunSchema.optional(),
});
export type TerminalOutputDetails = z.infer<typeof TerminalOutputDetailsSchema>;

export const TestFailureSchema = z.object({
  /** The test's name as the runner prints it. */
  name: z.string().max(500),
  /** Relative to the folder it ran in, with forward slashes, when the output says. */
  file: z.string().max(500).nullable(),
  line: z.number().int().nullable(),
  /** What went wrong (assertion text, exception), trimmed. */
  message: z.string().max(4000),
});
export type TestFailure = z.infer<typeof TestFailureSchema>;

export const TestRunSchema = z.object({
  /** The event id (agents' runs) or the Terminal run id. */
  id: z.string(),
  source: z.enum(["agent", "terminal"]),
  projectId: z.string(),
  taskId: z.string().nullable(),
  /** Where it ran: "Your project" or the task's title. */
  target: z.string(),
  /** The agent tag (`testing@1.0.0`), or `user` for the owner's Terminal runs. */
  by: z.string(),
  command: z.string(),
  at: z.string(),
  durationMs: z.number().int().nullable(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  passed: z.number().int().nullable(),
  failed: z.number().int().nullable(),
  summary: z.string(),
  /** pytest, unittest, jest, vitest, bun, go, cargo, or null when the output was not recognised. */
  format: z.string().nullable(),
  failures: z.array(TestFailureSchema).max(50),
  /** The end of the output, for runs whose failures could not be read one by one. */
  outputTail: z.string(),
});
export type TestRun = z.infer<typeof TestRunSchema>;

const Target = { projectId: z.string(), taskId: z.string().optional() };

export const TerminalMethods = {
  /** Run one command. Returns at once; output arrives as `terminal_output` events. */
  "terminal.run": {
    params: z
      .object({
        ...Target,
        command: z.string().min(1).max(4000),
        /** Default 10 minutes. */
        timeoutSeconds: z.number().int().min(1).max(3600).optional(),
      })
      .strict(),
    result: z.object({ run: TerminalRunSchema }),
  },
  /** A run's kept output (the last 2000 lines) after line `after`, for a UI that reconnects. */
  "terminal.read": {
    params: z.object({ runId: z.string(), after: z.number().int().min(0).optional() }).strict(),
    result: z.object({
      run: TerminalRunSchema,
      lines: z.array(TerminalLineSchema),
      next: z.number().int(),
      /** Older lines were dropped from the buffer. */
      dropped: z.boolean(),
    }),
  },
  "terminal.kill": {
    params: z.object({ runId: z.string() }).strict(),
    result: z.object({ killed: z.boolean() }),
  },
  /** Recent runs of a project, newest first. */
  "terminal.list": {
    params: z.object({ projectId: z.string(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    result: z.object({ runs: z.array(TerminalRunSchema) }),
  },
  /** Commands the owner ran in this project, newest first (last 50, no repeats). */
  "terminal.history": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ commands: z.array(z.string()) }),
  },
  /** Test runs, newest first: agents' runs and Terminal runs of test commands. */
  "tests.runs": {
    params: z.object({ ...Target, limit: z.number().int().min(1).max(100).optional() }).strict(),
    result: z.object({ runs: z.array(TestRunSchema) }),
  },
} as const;
