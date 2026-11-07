import type { DepoEvent, TerminalLine, TerminalRun } from "@depo/shared";
import { TerminalOutputDetailsSchema } from "@depo/shared";
import { create } from "zustand";

/**
 * Live Terminal output and the bottom panel's target. `terminal_output` events (ephemeral) land
 * here instead of the activity feed; each run keeps its newest 2000 lines. When lines are missing
 * (the UI connected mid-run, or events were dropped) `gap` is set and the Terminal tab reads the
 * run's buffer from the engine (`terminal.read`).
 */

export const MAX_TERMINAL_LINES = 2000;
const MAX_RUNS = 20;

export interface RunOutput {
  lines: TerminalLine[];
  lastSeq: number;
  run: TerminalRun | null;
  /** Some lines never arrived: read the buffer again. */
  gap: boolean;
  /** Older lines were dropped (only the newest 2000 are kept). */
  dropped: boolean;
  /** "Clear" hides everything up to this line. */
  clearedAt: number;
  /** Order of arrival, for dropping the oldest runs. */
  touched: number;
}

interface TerminalState {
  outputs: Record<string, RunOutput>;
  /** The run shown in the Terminal tab, per project. */
  selected: Record<string, string | null>;
  /** Where commands run and checks look, per project: a task id, or null for the project folder. */
  target: Record<string, string | null>;
  receive(event: DepoEvent): void;
  /** Lines read from the engine (terminal.read), merged with what arrived live. */
  merge(run: TerminalRun, lines: TerminalLine[], dropped?: boolean): void;
  select(projectId: string, runId: string | null): void;
  setTarget(projectId: string, taskId: string | null): void;
  clear(runId: string): void;
}

let tick = 0;

function empty(): RunOutput {
  return { lines: [], lastSeq: 0, run: null, gap: false, dropped: false, clearedAt: 0, touched: ++tick };
}

function capRuns(outputs: Record<string, RunOutput>): Record<string, RunOutput> {
  const ids = Object.keys(outputs);
  if (ids.length <= MAX_RUNS) return outputs;
  const keep = ids.sort((a, b) => (outputs[b]?.touched ?? 0) - (outputs[a]?.touched ?? 0)).slice(0, MAX_RUNS);
  return Object.fromEntries(keep.map((id) => [id, outputs[id] as RunOutput]));
}

/** Append lines newer than what is there; note a gap when some are missing. */
export function appendLines(out: RunOutput, lines: TerminalLine[]): RunOutput {
  const fresh = lines.filter((l) => l.seq > out.lastSeq);
  if (fresh.length === 0) return out;
  const first = fresh[0]?.seq ?? 0;
  const gap = out.gap || first > out.lastSeq + 1;
  const all = [...out.lines, ...fresh];
  return {
    ...out,
    lines: all.length > MAX_TERMINAL_LINES ? all.slice(all.length - MAX_TERMINAL_LINES) : all,
    lastSeq: fresh.at(-1)?.seq ?? out.lastSeq,
    gap,
    dropped: out.dropped || all.length > MAX_TERMINAL_LINES,
    touched: ++tick,
  };
}

export const useTerminal = create<TerminalState>((set) => ({
  outputs: {},
  selected: {},
  target: {},
  receive: (event) => {
    const parsed = TerminalOutputDetailsSchema.safeParse(event.details);
    if (!parsed.success) return;
    const d = parsed.data;
    set((s) => {
      const prev = s.outputs[d.runId] ?? empty();
      let next = appendLines(prev, d.lines);
      if (d.run) next = { ...next, run: d.run, touched: ++tick };
      return { outputs: capRuns({ ...s.outputs, [d.runId]: next }) };
    });
  },
  merge: (run, lines, dropped = false) =>
    set((s) => {
      const prev = s.outputs[run.id] ?? empty();
      const bySeq = new Map<number, TerminalLine>();
      for (const l of [...lines, ...prev.lines]) bySeq.set(l.seq, l);
      const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      const capped = all.length > MAX_TERMINAL_LINES ? all.slice(all.length - MAX_TERMINAL_LINES) : all;
      // The live copy may already be newer than the answer (it finished meanwhile).
      const newer = prev.run && prev.run.state !== "running" && run.state === "running" ? prev.run : run;
      const next: RunOutput = {
        ...prev,
        lines: capped,
        lastSeq: Math.max(prev.lastSeq, capped.at(-1)?.seq ?? 0),
        run: newer,
        gap: false,
        dropped: prev.dropped || dropped || all.length > MAX_TERMINAL_LINES,
        touched: ++tick,
      };
      return { outputs: capRuns({ ...s.outputs, [run.id]: next }) };
    }),
  select: (projectId, runId) => set((s) => ({ selected: { ...s.selected, [projectId]: runId } })),
  setTarget: (projectId, taskId) => set((s) => ({ target: { ...s.target, [projectId]: taskId } })),
  clear: (runId) =>
    set((s) => {
      const prev = s.outputs[runId];
      if (!prev) return {};
      return { outputs: { ...s.outputs, [runId]: { ...prev, clearedAt: prev.lastSeq } } };
    }),
}));

/** The bottom panel's target for a project (null = the project folder). */
export function useBottomTarget(projectId: string | null): string | null {
  return useTerminal((s) => (projectId ? (s.target[projectId] ?? null) : null));
}
