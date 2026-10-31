/**
 * Redact secrets before anything is logged or shown in the activity feed.
 * Covers: secret-looking object keys, `KEY=value` lines (e.g. from .env files),
 * bearer tokens, and common token formats.
 */
const SECRET_WORDS = new Set([
  "pass",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "cookie",
  "apikey",
  "privatekey",
  "session",
]);
const SECRET_PAIRS = new Set(["api key", "private key", "access key", "client secret", "session id"]);

/**
 * Does this key or variable name hold a secret? Names are split into words (snake, kebab,
 * camelCase), so `GITHUB_TOKEN`, `dbPassword` and `api-key` match while `passed`,
 * `completionTokens` and `bypass` do not.
 */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (SECRET_WORDS.has(w)) return true;
    if (i + 1 < words.length && SECRET_PAIRS.has(`${w} ${words[i + 1]}`)) return true;
  }
  return false;
}
const SECRET_KEY = { test: isSecretName };

const PATTERNS: RegExp[] = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `NAME=value` lines: .env files, `export NAME=`, cmd `set NAME=`, PowerShell `$env:NAME =`. */
const ENV_LINE = /^(\s*(?:export\s+|set\s+|\$env:)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/gim;
/** Inline `NAME=value` inside a longer command line, e.g. `API_KEY=abc npm start`. */
const INLINE_ASSIGN = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"']+)/g;

export const REDACTED = "«redacted»";

export function redactString(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, (_match, bearer?: string) =>
      typeof bearer === "string" && /^bearer$/i.test(bearer) ? `${bearer} ${REDACTED}` : REDACTED,
    );
  }
  out = out.replace(ENV_LINE, (line, lhs: string, value: string) => {
    const name = (lhs.split("=")[0] ?? "").replace(/^\s*(export\s+|set\s+|\$env:)/i, "");
    return SECRET_KEY.test(name) && value.trim() !== REDACTED ? `${lhs}${REDACTED}` : line;
  });
  out = out.replace(INLINE_ASSIGN, (whole, name: string, eq: string, value: string) =>
    SECRET_KEY.test(name) && value !== REDACTED ? `${name}${eq}${REDACTED}` : whole,
  );
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && v !== null && typeof v !== "object" ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
