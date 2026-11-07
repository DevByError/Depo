import type { DepoEvent, TerminalRun, TestRun } from "@depo/shared";
import { parseTestOutput } from "./test-parsers";

/**
 * Test runs for the Test results tab: the `test_result` events agents' run_command calls leave
 * in the audit log, and the owner's Terminal runs of commands the policy classifies as tests.
 * Failures are parsed from the kept output when the format is known.
 */

const TAIL = 4000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

export function testRunFromEvent(e: DepoEvent, target: string, root?: string): TestRun | null {
  const d = e.details ?? {};
  const command = typeof d.command === "string" ? d.command : null;
  if (!command || !e.projectId) return null;
  const output = typeof d.outputTail === "string" ? d.outputTail : "";
  const parsed = parseTestOutput(output, root);
  const ok = e.status === "succeeded";
  const passed = num(d.passed) ?? parsed.passed;
  const failed = num(d.failed) ?? parsed.failed;
  return {
    id: e.id,
    source: "agent",
    projectId: e.projectId,
    taskId: e.taskId,
    target,
    by: e.agent,
    command,
    at: e.ts,
    durationMs: e.durationMs,
    ok,
    exitCode: num(d.exitCode),
    passed,
    failed,
    summary: parsed.summary ?? e.text.replace(/^Tests:\s*/, ""),
    format: parsed.format,
    failures: ok ? [] : parsed.failures,
    outputTail: output.slice(-TAIL),
  };
}

export function testRunFromTerminal(run: TerminalRun, output: string, root?: string): TestRun {
  const parsed = parseTestOutput(output, root);
  const ok = run.state === "succeeded";
  const summary =
    parsed.summary ??
    (run.state === "timed_out"
      ? "Stopped at the time limit"
      : run.state === "stopped"
        ? "Stopped"
        : ok
          ? "Passed"
          : `Exited with ${run.exitCode ?? "an error"}`);
  return {
    id: run.id,
    source: "terminal",
    projectId: run.projectId,
    taskId: run.taskId,
    target: run.target,
    by: "user",
    command: run.command,
    at: run.startedAt,
    durationMs: run.durationMs,
    ok,
    exitCode: run.exitCode,
    passed: parsed.passed,
    failed: parsed.failed,
    summary,
    format: parsed.format,
    failures: ok ? [] : parsed.failures,
    outputTail: output.slice(-TAIL),
  };
}
