import type { DepoEvent, TerminalLine, TerminalRun, TerminalTone } from "@depo/shared";
import { formatDuration } from "./format";
import { queryClient } from "./query";

/** Helpers for the Terminal, Test results and Problems tabs. */

export const NO_INPUT_HINT = "Commands that wait for input are not supported. Add flags like -y.";

/** Theme colours for the tones the engine read from a program's colour codes. */
export const TONE_CLASS: Record<TerminalTone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
  info: "text-info",
  muted: "text-subtle",
};

export function lineClass(line: TerminalLine): string {
  if (line.stream === "depo") return "text-subtle italic";
  return line.tone ? TONE_CLASS[line.tone] : "text-fg";
}

/**
 * Up/Down through the command history (newest first). `index` -1 is the line being typed, kept
 * in `draft` so coming back down restores it.
 */
export function historyStep(
  history: string[],
  index: number,
  dir: "up" | "down",
  draft: string,
): { index: number; value: string } {
  if (dir === "up") {
    const next = Math.min(index + 1, history.length - 1);
    if (next < 0) return { index: -1, value: draft };
    return { index: next, value: history[next] ?? draft };
  }
  const next = index - 1;
  if (next < 0) return { index: -1, value: draft };
  return { index: next, value: history[next] ?? draft };
}

/** Newest first, no repeats: what the owner just ran goes to the front. */
export function pushHistory(history: string[], command: string, max = 50): string[] {
  return [command, ...history.filter((c) => c !== command)].slice(0, max);
}

export function isActive(run: Pick<TerminalRun, "state"> | null | undefined): boolean {
  return run?.state === "running";
}

/** "0.4s", "12s", "1m 20s". */
export function shortDuration(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** "Running for 3.0s", "Exit code 1, took 2.5s", "Stopped after 4.1s", … */
export function runStateText(run: TerminalRun, now = Date.now()): string {
  const took = run.durationMs ?? Math.max(0, now - new Date(run.startedAt).getTime());
  const time = shortDuration(took);
  switch (run.state) {
    case "running":
      return `Running for ${time}`;
    case "succeeded":
      return `Exit code 0, took ${time}`;
    case "failed":
      return run.exitCode === null ? `Failed after ${time}` : `Exit code ${run.exitCode}, took ${time}`;
    case "stopped":
      return `Stopped after ${time}`;
    case "timed_out":
      return `Stopped at the time limit after ${time}`;
  }
}

/** A run that ended badly and is worth sending to an agent. */
export function runFailed(run: TerminalRun | null | undefined): boolean {
  return !!run && (run.state === "failed" || run.state === "timed_out");
}

/** Prefer the live copy of a run while it is running or newer. */
export function newestRun(listed: TerminalRun, live: TerminalRun | null | undefined): TerminalRun {
  if (!live) return listed;
  if (listed.state !== "running" && live.state === "running") return listed;
  return live;
}

/** Keep the Terminal, Test results and Problems queries fresh as the engine reports changes. */
export function invalidateForChecks(e: DepoEvent): void {
  const source = e.details?.source;
  if (e.type === "running_command" && source === "terminal") {
    void queryClient.invalidateQueries({ queryKey: ["terminal"] });
    void queryClient.invalidateQueries({ queryKey: ["tests"] });
  } else if (e.type === "test_result") {
    void queryClient.invalidateQueries({ queryKey: ["tests"] });
  } else if (e.type === "linting" && source === "diagnostics") {
    void queryClient.invalidateQueries({ queryKey: ["diagnostics", "latest"] });
  } else if (
    e.type === "preview_started" ||
    e.type === "preview_stopped" ||
    (e.type === "rendering_screenshot" && e.status !== "started")
  ) {
    void queryClient.invalidateQueries({ queryKey: ["diagnostics", "runtime"] });
  }
}
