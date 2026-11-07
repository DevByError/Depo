import type { ChatItem } from "@depo/shared";
import { CheckCheck, Clock, CornerDownRight, MessageSquareOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { agentName } from "@/lib/step-summary";

/** "Manager", "Manager and Backend", "Manager, Backend and 3 more". */
export function readersText(readBy: string[]): string {
  const names = [
    ...new Set(readBy.map((t) => (t.startsWith("coder@") ? "the coding agent" : agentName(t)))),
  ].filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** What happened to a note sent while the task worked, in a few words. */
export function noteStatus(item: ChatItem): string {
  const s = item.steer;
  if (!s) return "";
  switch (s.state) {
    case "queued":
      return "Will be read at the next step";
    case "delivered": {
      const who = readersText(s.readBy);
      return who ? `Read by ${who}` : "Read";
    }
    case "dropped":
      return "Not read: the task stopped first";
    case "followup":
      return "Sent as the next message";
  }
}

const ICON = {
  queued: Clock,
  delivered: CheckCheck,
  dropped: MessageSquareOff,
  followup: CornerDownRight,
} as const;

/** A note the owner sent while the task worked: queued, then read (and by whom). */
export function SteerNote({ item }: { item: ChatItem }) {
  const state = item.steer?.state ?? "queued";
  const Icon = ICON[state];
  return (
    <div className="flex flex-col items-end gap-1" data-testid="steer-note" data-state={state}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg",
          state === "queued" ? "border border-dashed border-border-strong bg-transparent" : "bg-hover",
          state === "dropped" && "text-muted",
        )}
      >
        <span className="sr-only">Your note: </span>
        {item.text}
      </div>
      <span
        className={cn(
          "inline-flex items-center gap-1 pr-1 text-[11px]",
          state === "delivered" ? "text-muted" : state === "dropped" ? "text-warning" : "text-subtle",
        )}
      >
        <Icon className={cn("size-3", state === "delivered" && "text-success")} aria-hidden />
        {noteStatus(item)}
      </span>
    </div>
  );
}
