import { cn } from "@/lib/cn";
import type { ConnectionStatus } from "@/lib/engine-client";

const LABEL: Record<ConnectionStatus, string> = {
  idle: "Not started",
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  stopped: "Stopped",
};

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 rounded-full",
        status === "open" ? "bg-success" : status === "reconnecting" ? "bg-warning" : "bg-subtle",
      )}
    />
  );
}

export function connectionLabel(status: ConnectionStatus): string {
  return LABEL[status];
}
