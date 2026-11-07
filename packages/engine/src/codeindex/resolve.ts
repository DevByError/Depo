import path from "node:path";

/**
 * Turns an import as written into a project file: relative paths, TypeScript `paths` aliases from
 * tsconfig/jsconfig (with `extends` and `baseUrl`), workspace packages (package.json names), Python
 * packages (absolute, relative, `src/` layouts), Go modules, Rust `mod`/`use`, and a best effort for
 * Java, Kotlin, PHP, Ruby, C and Dart. Everything works on the list of indexed files plus a few small
 * config files, so it never touches node_modules or a virtual environment.
 */

export interface ImportRef {
  spec: string;
  name: string;
  kind: string;
}

export interface ResolverInput {
  /** Every indexed file, relative with forward slashes. */
  files: Iterable<string>;
  /** Reads a small project file (config), or null. */
  read(rel: string): string | null;
}

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro"];
const JS_EXTRA_EXT = [".d.ts", ".json", ".css", ".scss"];
const JS_FILE = /\.(m|c)?[jt]sx?$|\.(vue|svelte|astro|mdx)$/i;
const SWAP_EXT: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

interface TsPaths {
  /** Folder `paths` targets are relative to. */
  base: string;
  /** Folder of `baseUrl`, when set (bare specifiers are tried against it). */
  baseUrl: string | null;
  paths: [string, string[]][];
}

interface PackageInfo {
  dir: string;
  entry: string[];
  exports: Record<string, unknown> | string | null;
}

const NODE_BUILTINS = new Set(
  "assert buffer child_process cluster console crypto dgram dns events fs http http2 https module net os path perf_hooks process querystring readline repl stream string_decoder timers tls tty url util v8 vm worker_threads zlib".split(
    " ",
  ),
);
const PY_STDLIB = new Set(
  "abc argparse array ast asyncio base64 bisect builtins calendar collections concurrent configparser contextlib contextvars copy csv ctypes dataclasses datetime decimal difflib email enum errno fnmatch fractions functools gc getpass gettext glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging lzma math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap threading time timeit tomllib traceback types typing unittest urllib uuid warnings weakref xml zipfile zoneinfo __future__".split(
    " ",
  ),
);

export class ImportResolver {
  private readonly files = new Set<string>();
  private readonly byBase = new Map<string, string[]>();
  private readonly dirFiles = new Map<string, string[]>();
  private readonly tsCache = new Map<string, TsPaths | null>();
  private packages: Map<string, PackageInfo> | null = null;
  private goModules: { dir: string; module: string }[] | null = null;
  private dartPackages: Map<string, string> | null = null;

  constructor(private readonly input: ResolverInput) {
    for (const f of input.files) {
      this.files.add(f);
      const base = f.slice(f.lastIndexOf("/") + 1).toLowerCase();
      const list = this.byBase.get(base) ?? [];
      list.push(f);
      this.byBase.set(base, list);
      const dir = dirOf(f);
      const inDir = this.dirFiles.get(dir) ?? [];
      inDir.push(f);
      this.dirFiles.set(dir, inDir);
    }
    for (const list of this.dirFiles.values()) list.sort();
  }

  has(rel: string): boolean {
    return this.files.has(rel);
  }

  /** The project file `imp` (written in `importer`) refers to, or null (a library, or not found). */
  resolve(importer: string, imp: ImportRef): string | null {
    const spec = imp.spec.trim();
    if (!spec) return null;
    const target = this.resolveInner(importer, { ...imp, spec });
    return target && target !== importer ? target : null;
  }

  private resolveInner(importer: string, imp: ImportRef): string | null {
    const ext = path.posix.extname(importer).toLowerCase();
    if (JS_FILE.test(importer) || /\.(css|scss|sass|less|html?)$/i.test(importer))
      return this.resolveJs(importer, imp.spec);
    switch (ext) {
      case ".py":
      case ".pyi":
        return this.resolvePython(importer, imp);
      case ".go":
        return this.resolveGo(imp.spec);
      case ".rs":
        return this.resolveRust(importer, imp);
      case ".java":
      case ".kt":
      case ".kts":
        return this.resolveDotted(importer, imp.spec, [".java", ".kt"]);
      case ".php":
        return imp.kind === "include"
          ? this.relativeFile(importer, imp.spec.replace(/^\//, "./"))
          : this.bySuffix(`${imp.spec.replace(/\\/g, "/")}.php`, importer, true);
      case ".rb":
        return imp.spec.startsWith(".")
          ? this.relativeFile(importer, withExt(imp.spec, ".rb"))
          : (this.bySuffix(`lib/${withExt(imp.spec, ".rb")}`, importer) ??
              this.bySuffix(withExt(imp.spec, ".rb"), importer));
      case ".c":
      case ".h":
      case ".cc":
      case ".cpp":
      case ".hpp":
        return this.relativeFile(importer, `./${imp.spec}`) ?? this.bySuffix(imp.spec, importer);
      case ".dart":
        return this.resolveDart(importer, imp.spec);
      default:
        return null;
    }
  }

  /**
   * The library an unresolved import names (`react`, `@tanstack/react-query`, `fastapi`), for the
   * "uses" list; null for relative paths, aliases, the standard library and other languages.
   */
  external(importer: string, imp: ImportRef): string | null {
    const spec = imp.spec.trim();
    if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null;
    if (JS_FILE.test(importer)) {
      if (/^(node:|bun:|deno:|virtual:|~|#|@\/|\$)/.test(spec) || /^[a-z]+:\/\//i.test(spec)) return null;
      const parts = spec.split("/");
      const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
      if (!name || NODE_BUILTINS.has(name) || (spec.startsWith("@") && parts.length < 2)) return null;
      return name;
    }
    if (/\.pyi?$/.test(importer)) {
      const top = spec.split(".")[0] ?? "";
      return top && !PY_STDLIB.has(top) ? top : null;
    }
    return null;
  }

  // ---- JavaScript and TypeScript -------------------------------------------------------------

  private resolveJs(importer: string, rawSpec: string): string | null {
    const spec = rawSpec.split(/[?#]/)[0] ?? "";
    if (!spec) return null;
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..")
      return this.jsCandidates(joinRel(dirOf(importer), spec));
    if (spec.startsWith("/")) {
      return this.jsCandidates(joinRel(dirOf(importer), `.${spec}`)) ?? this.jsCandidates(spec.slice(1));
    }
    const ts = this.tsPathsFor(dirOf(importer));
    if (ts) {
      for (const [pattern, targets] of ts.paths) {
        const star = pattern.indexOf("*");
        let rest: string | null = null;
        if (star < 0) rest = pattern === spec ? "" : null;
        else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)
            rest = spec.slice(pre.length, spec.length - post.length);
        }
        if (rest === null) continue;
        for (const t of targets) {
          const hit = this.jsCandidates(joinRel(ts.base, `./${t.replace("*", rest)}`));
          if (hit) return hit;
        }
      }
      if (ts.baseUrl !== null) {
        const hit = this.jsCandidates(joinRel(ts.baseUrl, `./${spec}`));
        if (hit) return hit;
      }
    }
    return this.resolvePackage(spec);
  }

  private jsCandidates(base: string | null): string | null {
    if (base === null) return null;
    const b = base.replace(/\/$/, "");
    if (b && this.files.has(b)) return b;
    const ext = path.posix.extname(b);
    for (const swap of SWAP_EXT[ext] ?? []) {
      const c = b.slice(0, -ext.length) + swap;
      if (this.files.has(c)) return c;
    }
    for (const e of [...JS_EXT, ...JS_EXTRA_EXT]) if (this.files.has(b + e)) return b + e;
    const prefix = b ? `${b}/` : "";
    for (const e of JS_EXT) if (this.files.has(`${prefix}index${e}`)) return `${prefix}index${e}`;
    return null;
  }

  /** Nearest tsconfig.json / jsconfig.json at or above `dir` with `paths` or `baseUrl`. */
  private tsPathsFor(dir: string): TsPaths | null {
    const cached = this.tsCache.get(dir);
    if (cached !== undefined) return cached;
    let found: TsPaths | null = null;
    for (const name of ["tsconfig.json", "jsconfig.json", "tsconfig.app.json"]) {
      const rel = dir ? `${dir}/${name}` : name;
      if (!this.files.has(rel)) continue;
      found = this.readTsConfig(rel, 0);
      if (found) break;
    }
    if (!found && dir) found = this.tsPathsFor(dirOf(dir));
    this.tsCache.set(dir, found);
    return found;
  }

  private readTsConfig(rel: string, depth: number): TsPaths | null {
    if (depth > 4) return null;
    const json = parseJsonc(this.input.read(rel));
    if (!json || typeof json !== "object") return null;
    const cfg = json as {
      extends?: string | string[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      references?: { path?: string }[];
    };
    const dir = dirOf(rel);
    const opts = cfg.compilerOptions ?? {};
    const baseUrl = typeof opts.baseUrl === "string" ? joinRel(dir, `./${opts.baseUrl}`) : null;
    if (opts.paths && typeof opts.paths === "object") {
      const paths = Object.entries(opts.paths)
        .filter((e): e is [string, string[]] => Array.isArray(e[1]))
        .map(([k, v]) => [k, v.filter((x) => typeof x === "string")] as [string, string[]]);
      return { base: baseUrl ?? dir, baseUrl, paths };
    }
    // Inherited settings: `extends` (relative files only), then project references (Vite apps).
    const parents =
      typeof cfg.extends === "string" ? [cfg.extends] : Array.isArray(cfg.extends) ? cfg.extends : [];
    for (const p of parents) {
      if (typeof p !== "string" || !p.startsWith(".")) continue;
      const target = joinRel(dir, p.endsWith(".json") ? p : `${p}.json`);
      if (!target || !this.files.has(target)) continue;
      const inherited = this.readTsConfig(target, depth + 1);
      if (inherited) return baseUrl && !inherited.baseUrl ? { ...inherited, baseUrl } : inherited;
    }
    for (const ref of cfg.references ?? []) {
      if (typeof ref?.path !== "string") continue;
      let target = joinRel(dir, ref.path.startsWith(".") ? ref.path : `./${ref.path}`);
      if (target && !target.endsWith(".json")) target = `${target}/tsconfig.json`;
      if (!target || !this.files.has(target) || target === rel) continue;
      const referenced = this.readTsConfig(target, depth + 1);
      if (referenced) return referenced;
    }
    return baseUrl ? { base: baseUrl, baseUrl, paths: [] } : null;
  }

  /** Workspace packages by their package.json name (monorepos: `@acme/shared`, `@acme/shared/x`). */
  private resolvePackage(spec: string): string | null {
    if (!this.packages) {
      this.packages = new Map();
      for (const f of this.files) {
        if (f !== "package.json" && !f.endsWith("/package.json")) continue;
        const json = parseJsonc(this.input.read(f)) as {
          name?: unknown;
          main?: unknown;
          module?: unknown;
          types?: unknown;
          exports?: unknown;
        } | null;
        if (!json || typeof json.name !== "string") continue;
        const entry = [json.module, json.main, json.types].filter((x): x is string => typeof x === "string");
        const exp = json.exports;
        this.packages.set(json.name, {
          dir: dirOf(f),
          entry,
          exports:
            typeof exp === "string" || (exp && typeof exp === "object")
              ? (exp as Record<string, unknown> | string)
              : null,
        });
      }
    }
    let best: [string, PackageInfo] | null = null;
    for (const entry of this.packages) {
      const [name] = entry;
      if ((spec === name || spec.startsWith(`${name}/`)) && (!best || name.length > best[0].length))
        best = entry;
    }
    if (!best) return null;
    const [name, pkg] = best;
    const sub = spec.slice(name.length).replace(/^\//, "");
    const key = sub ? `./${sub}` : ".";
    const exported = exportTarget(pkg.exports, key);
    const tries = [
      ...(exported ? [exported] : []),
      ...(sub ? [`./${sub}`, `./src/${sub}`] : [...pkg.entry, "./src/index", "./index"]),
    ];
    for (const t of tries) {
      const hit = this.jsCandidates(joinRel(pkg.dir, t.startsWith(".") ? t : `./${t}`));
      if (hit) return hit;
    }
    return null;
  }

  // ---- Python ------------------------------------------------------------------------------

  private resolvePython(importer: string, imp: ImportRef): string | null {
    const spec = imp.spec;
    const name = imp.name && imp.name !== "*" ? imp.name : "";
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    if (dots > 0) {
      let base = dirOf(importer);
      for (let i = 1; i < dots; i++) base = dirOf(base);
      const rest = spec.slice(dots).replace(/\./g, "/");
      const mod = rest ? (base ? `${base}/${rest}` : rest) : base;
      if (name) {
        const sub = this.pyModule(mod ? `${mod}/${name}` : name);
        if (sub) return sub;
      }
      return this.pyModule(mod);
    }
    const parts = spec.split(".").filter(Boolean);
    if (name) {
      const sub = this.pyAbsolute([...parts, name], importer);
      if (sub) return sub;
    }
    // `import a.b.c` where c is a class or function: fall back to the longest module that exists.
    for (let n = parts.length; n > 0; n--) {
      const hit = this.pyAbsolute(parts.slice(0, n), importer);
      if (hit) return hit;
    }
    return null;
  }

  private pyModule(rel: string): string | null {
    for (const c of [`${rel}.py`, `${rel}/__init__.py`, `${rel}.pyi`]) {
      const clean = c.replace(/^\//, "");
      if (this.files.has(clean)) return clean;
    }
    return null;
  }

  private pyAbsolute(parts: string[], importer: string): string | null {
    const rel = parts.join("/");
    return this.bySuffix(`${rel}.py`, importer) ?? this.bySuffix(`${rel}/__init__.py`, importer);
  }

  // ---- Go, Rust, JVM, Dart -----------------------------------------------------------------

  private resolveGo(spec: string): string | null {
    if (!this.goModules) {
      this.goModules = [];
      for (const f of this.files) {
        if (f !== "go.mod" && !f.endsWith("/go.mod")) continue;
        const m = /^module\s+(\S+)/m.exec(this.input.read(f) ?? "");
        if (m?.[1]) this.goModules.push({ dir: dirOf(f), module: m[1] });
      }
    }
    for (const g of this.goModules) {
      if (spec !== g.module && !spec.startsWith(`${g.module}/`)) continue;
      const sub = spec.slice(g.module.length).replace(/^\//, "");
      const dir = [g.dir, sub].filter(Boolean).join("/");
      const first = (this.dirFiles.get(dir) ?? []).find((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
      if (first) return first;
    }
    return null;
  }

  private resolveRust(importer: string, imp: ImportRef): string | null {
    const dir = dirOf(importer);
    const stem = path.posix.basename(importer, ".rs");
    if (imp.kind === "mod") {
      const base =
        stem === "main" || stem === "lib" || stem === "mod" ? dir : [dir, stem].filter(Boolean).join("/");
      const pre = base ? `${base}/` : "";
      for (const c of [`${pre}${imp.spec}.rs`, `${pre}${imp.spec}/mod.rs`]) if (this.files.has(c)) return c;
      return null;
    }
    const segs = imp.spec.split("::").filter(Boolean);
    let base: string | null = null;
    if (segs[0] === "crate") {
      let d = dir;
      for (;;) {
        if (this.files.has(d ? `${d}/Cargo.toml` : "Cargo.toml")) {
          base = d ? `${d}/src` : "src";
          break;
        }
        if (!d) break;
        d = dirOf(d);
      }
      base ??= dir;
      segs.shift();
    } else if (segs[0] === "self" || segs[0] === "super") {
      base =
        stem === "mod" || stem === "lib" || stem === "main" ? dir : [dir, stem].filter(Boolean).join("/");
      while (segs[0] === "super") {
        base = dirOf(base);
        segs.shift();
      }
      if (segs[0] === "self") segs.shift();
    } else return null;
    for (let n = segs.length; n > 0; n--) {
      const rel = [base, ...segs.slice(0, n)].filter(Boolean).join("/");
      for (const c of [`${rel}.rs`, `${rel}/mod.rs`]) if (this.files.has(c)) return c;
    }
    return null;
  }

  private resolveDotted(importer: string, spec: string, exts: string[]): string | null {
    const parts = spec.replace(/\.\*$/, "").split(".").filter(Boolean);
    for (let n = parts.length; n > 1; n--) {
      const rel = parts.slice(0, n).join("/");
      for (const e of exts) {
        const hit = this.bySuffix(`${rel}${e}`, importer);
        if (hit) return hit;
      }
    }
    return null;
  }

  private resolveDart(importer: string, spec: string): string | null {
    if (spec.startsWith("dart:")) return null;
    const pkg = /^package:([\w]+)\/(.+)$/.exec(spec);
    if (pkg) {
      if (!this.dartPackages) {
        this.dartPackages = new Map();
        for (const f of this.files) {
          if (f !== "pubspec.yaml" && !f.endsWith("/pubspec.yaml")) continue;
          const name = /^name:\s*([\w]+)/m.exec(this.input.read(f) ?? "")?.[1];
          if (name) this.dartPackages.set(name, dirOf(f));
        }
      }
      const dir = this.dartPackages.get(pkg[1] ?? "");
      if (dir === undefined) return null;
      const rel = [dir, "lib", pkg[2]].filter(Boolean).join("/");
      return this.files.has(rel) ? rel : null;
    }
    return this.relativeFile(importer, spec.startsWith(".") ? spec : `./${spec}`);
  }

  // ---- shared helpers ----------------------------------------------------------------------

  private relativeFile(importer: string, spec: string): string | null {
    const rel = joinRel(dirOf(importer), spec);
    return rel && this.files.has(rel) ? rel : null;
  }

  /**
   * A file whose path ends with `rel`; when several do, the one closest to the importer wins
   * (longest shared folder prefix), then the shortest path.
   */
  private bySuffix(rel: string, importer: string, caseInsensitive = false): string | null {
    const clean = rel.replace(/^\/+/, "");
    const base = clean.slice(clean.lastIndexOf("/") + 1).toLowerCase();
    const want = caseInsensitive ? clean.toLowerCase() : clean;
    const matches = (this.byBase.get(base) ?? []).filter((f) => {
      const x = caseInsensitive ? f.toLowerCase() : f;
      return x === want || x.endsWith(`/${want}`);
    });
    if (matches.length <= 1) return matches[0] ?? null;
    const importerDir = dirOf(importer);
    let best = matches[0] ?? null;
    let bestScore = -1;
    for (const m of matches) {
      const root = m.slice(0, m.length - clean.length).replace(/\/$/, "");
      const shared =
        !root || importerDir === root || importerDir.startsWith(`${root}/`) ? root.length + 1 : 0;
      const score = shared * 1000 - m.length;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function withExt(spec: string, ext: string): string {
  return spec.endsWith(ext) ? spec : `${spec}${ext}`;
}

/** Join and normalise a relative path; null when it leaves the project. */
function joinRel(dir: string, spec: string): string | null {
  const joined = path.posix.normalize(dir ? `${dir}/${spec}` : spec);
  if (joined === "." || joined === "./") return "";
  if (joined.startsWith("../") || joined === "..") return null;
  return joined.replace(/^\.\//, "").replace(/\/$/, "");
}

/** JSON with comments and trailing commas (tsconfig), or null. */
export function parseJsonc(text: string | null): unknown {
  if (!text) return null;
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** The file a package `exports` map gives for a subpath (first string found, preferring source). */
function exportTarget(exp: PackageInfo["exports"], key: string): string | null {
  if (!exp) return null;
  if (typeof exp === "string") return key === "." ? exp : null;
  const hasSubpaths = Object.keys(exp).some((k) => k.startsWith("."));
  const node = hasSubpaths ? exp[key] : key === "." ? exp : undefined;
  return firstString(node, 0);
}

function firstString(v: unknown, depth: number): string | null {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || depth > 4) return null;
  const o = v as Record<string, unknown>;
  for (const k of ["source", "bun", "import", "default", "require", "node", "types"]) {
    const s = firstString(o[k], depth + 1);
    if (s) return s;
  }
  for (const val of Object.values(o)) {
    const s = firstString(val, depth + 1);
    if (s) return s;
  }
  return null;
}
