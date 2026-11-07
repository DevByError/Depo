import type { Database } from "bun:sqlite";
import type { TerminalRun, TerminalRunState } from "@depo/shared";

/** Terminal runs and the per-project command history, in SQLite (migration 10). */

const KEEP_RUNS = 100;
const KEEP_HISTORY = 50;

interface RunRow {
  id: string;
  project_id: string;
  task_id: string | null;
  target: string;
  command: string;
  category: string;
  state: string;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  line_count: number;
  output_tail: string;
}

const STATES = new Set<TerminalRunState>(["running", "succeeded", "failed", "stopped", "timed_out"]);

function toRun(r: RunRow): TerminalRun {
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    target: r.target,
    command: r.command,
    category: r.category,
    state: STATES.has(r.state as TerminalRunState) ? (r.state as TerminalRunState) : "failed",
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    lines: r.line_count,
  };
}

export class TerminalStore {
  constructor(private readonly db: Database) {}

  /** Runs left "running" by an engine that stopped without finishing them. */
  recover(): number {
    return this.db
      .query(
        "UPDATE terminal_runs SET state = 'stopped', ended_at = COALESCE(ended_at, started_at) WHERE state = 'running'",
      )
      .run().changes;
  }

  insert(run: TerminalRun): void {
    this.db
      .query(
        `INSERT INTO terminal_runs (id, project_id, task_id, target, command, category, state, exit_code,
          started_at, ended_at, duration_ms, line_count, output_tail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.taskId,
        run.target,
        run.command,
        run.category,
        run.state,
        run.exitCode,
        run.startedAt,
        run.endedAt,
        run.durationMs,
        run.lines,
        "",
      );
    this.prune(run.projectId);
  }

  finish(run: TerminalRun, outputTail: string): void {
    this.db
      .query(
        "UPDATE terminal_runs SET state = ?, exit_code = ?, ended_at = ?, duration_ms = ?, line_count = ?, output_tail = ? WHERE id = ?",
      )
      .run(run.state, run.exitCode, run.endedAt, run.durationMs, run.lines, outputTail, run.id);
  }

  get(id: string): { run: TerminalRun; outputTail: string } | null {
    const r = this.db.query("SELECT * FROM terminal_runs WHERE id = ?").get(id) as RunRow | null;
    return r ? { run: toRun(r), outputTail: r.output_tail } : null;
  }

  list(projectId: string, limit: number): TerminalRun[] {
    const rows = this.db
      .query("SELECT * FROM terminal_runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(projectId, limit) as RunRow[];
    return rows.map(toRun);
  }

  /** Finished runs of one category (test runs for the Test results tab), newest first. */
  finishedOf(projectId: string, category: string, limit: number): { run: TerminalRun; outputTail: string }[] {
    const rows = this.db
      .query(
        "SELECT * FROM terminal_runs WHERE project_id = ? AND category = ? AND state != 'running' ORDER BY started_at DESC LIMIT ?",
      )
      .all(projectId, category, limit) as RunRow[];
    return rows.map((r) => ({ run: toRun(r), outputTail: r.output_tail }));
  }

  remember(projectId: string, command: string): void {
    this.db
      .query(
        "INSERT INTO terminal_history (project_id, command, used_at) VALUES (?,?,?) ON CONFLICT(project_id, command) DO UPDATE SET used_at = excluded.used_at",
      )
      .run(projectId, command, new Date().toISOString());
    this.db
      .query(
        `DELETE FROM terminal_history WHERE project_id = ? AND command NOT IN (
          SELECT command FROM terminal_history WHERE project_id = ? ORDER BY used_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(projectId, projectId, KEEP_HISTORY);
  }

  history(projectId: string): string[] {
    const rows = this.db
      .query(
        "SELECT command FROM terminal_history WHERE project_id = ? ORDER BY used_at DESC, rowid DESC LIMIT ?",
      )
      .all(projectId, KEEP_HISTORY) as { command: string }[];
    return rows.map((r) => r.command);
  }

  private prune(projectId: string): void {
    this.db
      .query(
        `DELETE FROM terminal_runs WHERE project_id = ? AND state != 'running' AND id NOT IN (
          SELECT id FROM terminal_runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?)`,
      )
      .run(projectId, projectId, KEEP_RUNS);
  }
}
