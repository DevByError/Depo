import type { DepoEvent } from "@depo/shared";

export interface Notice {
  title: string;
  text: string;
  level: "attention" | "info" | "problem";
  taskId: string | null;
}

/** Which engine events deserve the person's attention, and what to say about them. */
export function eventToNotice(e: DepoEvent): Notice | null {
  if (e.type === "waiting_for_user" && e.status === "started")
    return { title: "Needs your approval", text: e.text, level: "attention", taskId: e.taskId };
  if (e.type === "handoff" && e.taskId && (e.details?.changeSetId || e.text.startsWith("Finished with no")))
    return {
      title: e.details?.changeSetId ? "Changes are ready to review" : "Task finished",
      text: e.text,
      level: "info",
      taskId: e.taskId,
    };
  if (e.type === "error" && e.taskId && !e.ephemeral)
    return { title: "Something went wrong", text: e.text, level: "problem", taskId: e.taskId };
  return null;
}
