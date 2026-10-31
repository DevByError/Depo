/** Depo mark: a stacked depot of three layers (team, engine, your files). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--accent)" />
      <path d="M9 11.5 16 8l7 3.5-7 3.5z" fill="var(--accent-fg)" />
      <path
        d="m9 16 7 3.5 7-3.5"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="m9 20.5 7 3.5 7-3.5"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}
