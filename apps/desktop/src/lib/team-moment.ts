import type { TeamMoment } from "@/store/ui";

/**
 * A shared moment of a team run: a link-like reference such as
 * `depo://team/tsk_123?project=prj_1&at=754000` that reopens the replay at that time, inside Depo.
 * Nothing goes over the network; the reference only names a task and a time.
 */

export const MOMENT_SCHEME = "depo://team/";
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function momentRef(m: TeamMoment): string {
  const q = new URLSearchParams();
  if (m.projectId) q.set("project", m.projectId);
  q.set("at", String(Math.max(0, Math.round(m.atMs))));
  return `${MOMENT_SCHEME}${m.taskId}?${q.toString()}`;
}

/** The moment in a pasted reference, or null when the text is not one. */
export function parseMoment(text: string): TeamMoment | null {
  const s = text.trim();
  if (!s.toLowerCase().startsWith(MOMENT_SCHEME)) return null;
  const rest = s.slice(MOMENT_SCHEME.length);
  const [taskId = "", query = ""] = rest.split("?", 2);
  if (!ID.test(taskId)) return null;
  const q = new URLSearchParams(query);
  const at = Number(q.get("at") ?? "0");
  if (!Number.isFinite(at) || at < 0) return null;
  const project = q.get("project");
  return { taskId, projectId: project && ID.test(project) ? project : null, atMs: Math.round(at) };
}
