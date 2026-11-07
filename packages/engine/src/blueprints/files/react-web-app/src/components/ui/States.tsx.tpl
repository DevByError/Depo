import type { ReactNode } from "react";
import { Button } from "./Button";

/** Every data screen shows one of these while it has nothing else to show. */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-10 text-sm text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />
      {label}...
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-danger bg-danger-soft px-4 py-4">
      <div>
        <h2 className="text-sm font-semibold text-fg">Something went wrong</h2>
        <p className="mt-1 text-sm text-fg">{error.message}</p>
      </div>
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-fg">
      {children}
    </div>
  );
}
