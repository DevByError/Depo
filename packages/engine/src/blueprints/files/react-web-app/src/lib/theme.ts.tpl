export type Theme = "light" | "dark";

const KEY = "app.theme";

/** The saved choice, else the system setting. */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage blocked: fall through
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme, save = false): void {
  document.documentElement.dataset.theme = theme;
  if (!save) return;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // not saved; the theme still applies to this tab
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
