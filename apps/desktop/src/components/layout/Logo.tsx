/** Depo mark ("Bracket D"): the D of Depo, drawn as a crate with planks, between code brackets. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="15"
        fill="#1b1f27"
        stroke="#ffffff"
        strokeOpacity="0.14"
        strokeWidth="1.5"
      />
      <g fill="none" stroke="#8a93a6" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="14,20 6,32 14,44" />
        <polyline points="50,20 58,32 50,44" />
      </g>
      <path d="M20 16h11c10 0 16 6.5 16 16s-6 16-16 16H20z" fill="#ffffff" />
      <rect x="20" y="23" width="25" height="2.2" fill="#c7ccd6" />
      <rect x="20" y="39" width="25" height="2.2" fill="#c7ccd6" />
    </svg>
  );
}
