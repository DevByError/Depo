import type { LucideIcon } from "lucide-react";

/** Honest scope marker: this screen exists in the layout, its feature ships in a later phase. */
export function PhaseNotice({
  icon: Icon,
  title,
  phase,
  children,
}: {
  icon: LucideIcon;
  title: string;
  phase: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-raised text-muted">
          <Icon className="size-5" aria-hidden />
        </div>
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-accent">Arrives in {phase}</p>
        <div className="mt-3 text-[13px] leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  );
}
