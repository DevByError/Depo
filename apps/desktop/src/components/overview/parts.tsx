import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { TestBar } from "@/lib/code-map";
import { formatRelative } from "@/lib/format";

/** A titled card; it is a region named after its title, so screen readers can jump to it. */
export function Card({
  title,
  icon: Icon,
  action,
  className,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn("min-w-0 rounded-xl border border-border bg-panel p-4", className)}
    >
      <div className="mb-3 flex min-h-7 items-center gap-2">
        {Icon && <Icon className="size-4 shrink-0 text-muted" aria-hidden />}
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small link-like button inside a card ("Open Chat"). */
export function CardLink({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-hover"
    >
      {children}
    </button>
  );
}

/** A big number with its unit, for health cards. */
export function Stat({ value, unit, tone }: { value: ReactNode; unit?: ReactNode; tone?: string }) {
  return (
    <p className="flex items-baseline gap-1.5">
      <span className={cn("text-2xl font-semibold leading-none tabular-nums text-fg", tone)}>{value}</span>
      {unit && <span className="text-xs text-muted">{unit}</span>}
    </p>
  );
}

/**
 * The last test runs as bars, oldest on the left: green for a pass, red for a failure, the height
 * showing the share of tests that passed.
 */
export function TestSparkline({ bars }: { bars: TestBar[] }) {
  if (bars.length < 2) return null;
  const passes = bars.filter((b) => b.passed).length;
  const w = 6;
  const gap = 3;
  const h = 28;
  const width = bars.length * (w + gap) - gap;
  return (
    <svg
      role="img"
      aria-label={`Last ${bars.length} test runs: ${passes} passed, ${bars.length - passes} failed`}
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      className="mt-3 block max-w-full"
    >
      {bars.map((b, i) => {
        const bh = Math.max(
          4,
          Math.round(h * (b.passed ? Math.max(0.35, b.ratio) : Math.max(0.35, 1 - b.ratio))),
        );
        return (
          <rect
            key={b.id}
            x={i * (w + gap)}
            y={h - bh}
            width={w}
            height={bh}
            rx={1.5}
            className={b.passed ? "fill-success/70" : "fill-danger/80"}
          >
            <title>{`${b.text} · ${formatRelative(b.at)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted">
      {children}
    </div>
  );
}
