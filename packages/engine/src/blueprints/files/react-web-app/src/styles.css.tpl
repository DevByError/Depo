@import "tailwindcss";

/* Dark mode follows data-theme on <html> (set by src/lib/theme.ts). */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

/* Design tokens: change colours here, never inside components. Text pairs meet WCAG 2.2 AA. */
:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --raised: #eef1f4;
  --fg: #151a21;
  --muted: #566170;
  --border: #d9dee5;
  --accent: #0f766e;
  --accent-fg: #ffffff;
  --accent-soft: #e0f2ef;
  --danger: #b42318;
  --danger-soft: #fdecea;
  --success: #067647;
  --warning: #93370d;
  --focus: #0f766e;
}

[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0e1116;
  --panel: #151a21;
  --raised: #1c222b;
  --fg: #e8ebef;
  --muted: #9da6b3;
  --border: #2b323d;
  --accent: #2dd4bf;
  --accent-fg: #052e2a;
  --accent-soft: #10302d;
  --danger: #fb7c70;
  --danger-soft: #3a1714;
  --success: #4ade80;
  --warning: #fdb022;
  --focus: #2dd4bf;
}

@theme inline {
  --color-bg: var(--bg);
  --color-panel: var(--panel);
  --color-raised: var(--raised);
  --color-fg: var(--fg);
  --color-muted: var(--muted);
  --color-border: var(--border);
  --color-accent: var(--accent);
  --color-accent-fg: var(--accent-fg);
  --color-accent-soft: var(--accent-soft);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --font-sans: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
}

html,
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
