/**
 * Which language a file or a fenced code block is written in, for syntax highlighting.
 * Pure lookups, no grammar code: grammars load lazily in `tokenize.ts`.
 */

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "xml"
  | "markdown"
  | "yaml"
  | "toml"
  | "ini"
  | "sql"
  | "bash"
  | "console"
  | "powershell"
  | "batch"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "kotlin"
  | "swift"
  | "php"
  | "ruby"
  | "c"
  | "cpp"
  | "dockerfile"
  | "makefile"
  | "diff";

/** The highlight.js grammar module that reads each language. */
export type GrammarName =
  | "typescript"
  | "javascript"
  | "python"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "xml"
  | "markdown"
  | "yaml"
  | "ini"
  | "sql"
  | "bash"
  | "shell"
  | "powershell"
  | "dos"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "kotlin"
  | "swift"
  | "php"
  | "ruby"
  | "c"
  | "cpp"
  | "dockerfile"
  | "makefile"
  | "diff";

interface LanguageInfo {
  label: string;
  grammar: GrammarName;
}

export const LANGUAGES: Record<LanguageId, LanguageInfo> = {
  typescript: { label: "TypeScript", grammar: "typescript" },
  tsx: { label: "TSX", grammar: "typescript" },
  javascript: { label: "JavaScript", grammar: "javascript" },
  jsx: { label: "JSX", grammar: "javascript" },
  python: { label: "Python", grammar: "python" },
  json: { label: "JSON", grammar: "json" },
  css: { label: "CSS", grammar: "css" },
  scss: { label: "SCSS", grammar: "scss" },
  less: { label: "Less", grammar: "less" },
  html: { label: "HTML", grammar: "xml" },
  xml: { label: "XML", grammar: "xml" },
  markdown: { label: "Markdown", grammar: "markdown" },
  yaml: { label: "YAML", grammar: "yaml" },
  toml: { label: "TOML", grammar: "ini" },
  ini: { label: "INI", grammar: "ini" },
  sql: { label: "SQL", grammar: "sql" },
  bash: { label: "Shell", grammar: "bash" },
  console: { label: "Terminal", grammar: "shell" },
  powershell: { label: "PowerShell", grammar: "powershell" },
  batch: { label: "Batch", grammar: "dos" },
  go: { label: "Go", grammar: "go" },
  rust: { label: "Rust", grammar: "rust" },
  java: { label: "Java", grammar: "java" },
  csharp: { label: "C#", grammar: "csharp" },
  kotlin: { label: "Kotlin", grammar: "kotlin" },
  swift: { label: "Swift", grammar: "swift" },
  php: { label: "PHP", grammar: "php" },
  ruby: { label: "Ruby", grammar: "ruby" },
  c: { label: "C", grammar: "c" },
  cpp: { label: "C++", grammar: "cpp" },
  dockerfile: { label: "Dockerfile", grammar: "dockerfile" },
  makefile: { label: "Makefile", grammar: "makefile" },
  diff: { label: "Diff", grammar: "diff" },
};

const BY_EXTENSION: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  pyw: "python",
  pyi: "python",
  json: "json",
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svelte: "html",
  astro: "html",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  xaml: "xml",
  plist: "xml",
  csproj: "xml",
  fsproj: "xml",
  vbproj: "xml",
  props: "xml",
  targets: "xml",
  resx: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  editorconfig: "ini",
  npmrc: "ini",
  env: "ini",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "batch",
  cmd: "batch",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  csx: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  php: "php",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  dockerfile: "dockerfile",
  mk: "makefile",
  diff: "diff",
  patch: "diff",
};

const BY_NAME: Record<string, LanguageId> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".env": "ini",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  "cargo.lock": "toml",
  "poetry.lock": "toml",
  pipfile: "toml",
  gemfile: "ruby",
  rakefile: "ruby",
};

/** The language of a file, from its name or extension. Null when unknown (shown without colours). */
export function languageForPath(path: string): LanguageId | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!name) return null;
  const named = BY_NAME[name];
  if (named) return named;
  // Dockerfile.dev, .env.local and friends.
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name.startsWith(".env.")) return "ini";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

const FENCE_ALIASES: Record<string, LanguageId> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  jsx: "jsx",
  py: "python",
  python: "python",
  python3: "python",
  py3: "python",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
  xaml: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  dotenv: "ini",
  sql: "sql",
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql",
  pgsql: "sql",
  sqlite: "sql",
  tsql: "sql",
  plsql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  console: "console",
  terminal: "console",
  "shell-session": "console",
  shellsession: "console",
  ps: "powershell",
  ps1: "powershell",
  powershell: "powershell",
  pwsh: "powershell",
  posh: "powershell",
  bat: "batch",
  batch: "batch",
  cmd: "batch",
  dos: "batch",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  kt: "kotlin",
  kotlin: "kotlin",
  swift: "swift",
  php: "php",
  rb: "ruby",
  ruby: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  containerfile: "dockerfile",
  make: "makefile",
  makefile: "makefile",
  mk: "makefile",
  diff: "diff",
  patch: "diff",
};

/**
 * The language of a fenced code block from its info string: "ts", "python title=app.py",
 * "{.rust}", or a file name some models write instead ("app/main.py").
 */
export function languageForFence(info: string): LanguageId | null {
  const word = info
    .trim()
    .replace(/^\{\s*\.?/, "")
    .split(/[\s{},]+/)[0]
    ?.toLowerCase();
  if (!word) return null;
  const alias = FENCE_ALIASES[word];
  if (alias) return alias;
  if (/[./\\]/.test(word)) return languageForPath(word);
  return null;
}

/** A short name for the code block header ("TypeScript"); unknown fences show their own word. */
export function languageLabel(lang: LanguageId | null, info = ""): string {
  if (lang) return LANGUAGES[lang].label;
  const word = info.trim().split(/\s+/)[0] ?? "";
  if (!word || word === "text" || word === "plaintext" || word === "txt") return "Text";
  return word.length > 24 ? `${word.slice(0, 24)}…` : word;
}

export function grammarFor(lang: LanguageId): GrammarName {
  return LANGUAGES[lang].grammar;
}
