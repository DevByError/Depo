/*
 * The look of __DEPO_SLUG__. Every colour, the corner radius and the font come from the tokens
 * below; components use var(--...) only. Depo fills this block from a design reference.
 */
/* depo:theme:start */
:root {
  color-scheme: light;
  --bg: #f4f6fb;
  --page-bg: var(--bg);
  --surface: #ffffff;
  --surface-muted: #f1f4f9;
  --border: #dde3ec;
  --text: #1c2430;
  --muted: #5b6676;
  --primary: #1a6fd6;
  --primary-hover: #155db4;
  --primary-text: #ffffff;
  --accent: #0f9d8a;
  --danger: #b42318;
  --success: #067647;
  --focus: #1a6fd6;
  --radius: 12px;
  --font: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
}
/* depo:theme:end */

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

body {
  background: var(--page-bg);
  background-attachment: fixed;
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a {
  color: var(--primary);
  text-decoration: none;
  font-weight: 500;
}

a:hover {
  text-decoration: underline;
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
}

.card {
  width: 100%;
  max-width: 440px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) + 6px);
  box-shadow: 0 12px 40px rgb(15 23 42 / 0.08);
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--muted);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-weight: 600;
}

.brand-mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--primary);
}

.card-body {
  padding: 28px 28px 24px;
}

.card-body h1 {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 600;
  text-align: center;
}

.subtitle {
  margin: 0 0 22px;
  color: var(--muted);
  text-align: center;
}

.card-footer {
  padding: 14px 28px 18px;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
  color: var(--muted);
  font-size: 13px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.field-label {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 500;
}

.input {
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}

.input:focus {
  border-color: var(--primary);
  outline: 2px solid color-mix(in srgb, var(--primary) 25%, transparent);
  outline-offset: 0;
}

.input[aria-invalid="true"] {
  border-color: var(--danger);
}

.field-error {
  color: var(--danger);
  font-size: 13px;
}

.button {
  width: 100%;
  height: 42px;
  border: 0;
  border-radius: 999px;
  background: var(--primary);
  color: var(--primary-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  background: var(--primary-hover);
}

.button:disabled {
  opacity: 0.6;
  cursor: progress;
}

.button-secondary {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--border);
}

.button-secondary:hover:not(:disabled) {
  background: var(--surface-muted);
}

.alert {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  background: color-mix(in srgb, var(--danger) 8%, var(--surface));
  color: var(--danger);
  font-size: 14px;
}

.switch-line {
  margin: 16px 0 0;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}

.welcome {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--primary);
  color: var(--primary-text);
  font-weight: 600;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.muted {
  color: var(--muted);
}
