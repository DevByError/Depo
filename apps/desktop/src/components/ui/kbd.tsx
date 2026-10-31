import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-raised px-1 py-px font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
