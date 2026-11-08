import path from "node:path";

/**
 * Small models get the right tool but the wrong argument names: `file_path` for `path`, `text` for
 * `content`, `old_str`/`new_str` for an edit, `cmd` for `command`, or "/be/src" for a path inside
 * the project. Depo renames them before the arguments are checked, so the call runs instead of
 * failing with "Invalid arguments" (which a 3B model often repeats unchanged).
 */

const PATH_KEYS = ["path", "file", "filename", "file_name", "filepath", "file_path", "target_file", "target"];
const CONTENT_KEYS = ["content", "contents", "text", "code", "body", "data", "source", "file_content"];
const SEARCH_KEYS = [
  "search",
  "old_str",
  "old_string",
  "old",
  "old_text",
  "find",
  "original",
  "before",
  "from",
];
const REPLACE_KEYS = [
  "replace",
  "new_str",
  "new_string",
  "new",
  "new_text",
  "replacement",
  "updated",
  "after",
  "to",
];
const COMMAND_KEYS = ["command", "cmd", "script", "shell_command"];
const CWD_KEYS = ["cwd", "dir", "directory", "working_dir", "working_directory", "workdir", "folder"];
const PATTERN_KEYS = ["pattern", "query", "regex", "text", "search", "term", "keyword"];
const GLOB_KEYS = ["glob", "pattern", "name", "query", "file_pattern"];

type Args = Record<string, unknown>;

function pick(a: Args, keys: string[]): unknown {
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) return a[k];
  return undefined;
}

function without(a: Args, keys: string[]): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(a)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** "/be/src/app.ts" (meaning the project root) becomes "be/src/app.ts"; a real absolute path inside the root stays. */
export function projectPath(p: string, root?: string): string {
  const s = p.trim();
  if (!s.startsWith("/") && !s.startsWith("\\")) return s;
  if (root) {
    const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const r = norm(path.resolve(root));
    const n = norm(s);
    if (n === r || n.startsWith(`${r}/`)) return s;
  }
  return s.replace(/^[/\\]+/, "") || ".";
}

/** One edit in the shape edit_file takes, from whatever keys the model used. */
function oneEdit(e: unknown): unknown {
  if (!e || typeof e !== "object" || Array.isArray(e)) return e;
  const o = e as Args;
  const search = pick(o, SEARCH_KEYS);
  const replace = pick(o, REPLACE_KEYS);
  if (search === undefined && replace === undefined) return e;
  const out: Args = { search, replace: replace ?? "" };
  const all = o.replace_all ?? o.replaceAll;
  if (typeof all === "boolean") out.replace_all = all;
  return out;
}

/** The arguments with the names the tool takes, where the model used other names. Unknown tools pass through. */
export function normalizeArgs(name: string, raw: unknown, root?: string): unknown {
  let a = raw;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return raw;
    }
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) return raw;
  const o = { ...(a as Args) };
  const setPath = (keys = PATH_KEYS) => {
    const p = pick(o, keys);
    const rest = without(o, keys);
    return typeof p === "string" ? { ...rest, path: projectPath(p, root) } : o;
  };
  switch (name) {
    case "read_file": {
      const r = setPath();
      for (const [from, to] of [
        ["start", "start_line"],
        ["end", "end_line"],
        ["line_start", "start_line"],
        ["line_end", "end_line"],
      ] as const)
        if (r[from] !== undefined && r[to] === undefined) {
          r[to] = r[from];
          delete r[from];
        }
      return r;
    }
    case "list_dir": {
      const r = setPath([...PATH_KEYS, "dir", "directory", "folder"]);
      return r;
    }
    case "delete_file":
      return setPath();
    case "write_file":
    case "append_file": {
      const r = setPath();
      const c = pick(r, CONTENT_KEYS);
      if (typeof c !== "string") return r;
      return { ...without(r, CONTENT_KEYS), content: c };
    }
    case "edit_file": {
      const r = setPath();
      let edits = r.edits ?? r.changes ?? r.replacements ?? r.edit;
      if (typeof edits === "string") {
        try {
          edits = JSON.parse(edits);
        } catch {
          // left as it is; the check says what is wrong
        }
      }
      if (edits === undefined && (pick(r, SEARCH_KEYS) !== undefined || pick(r, REPLACE_KEYS) !== undefined))
        edits = [r];
      if (edits && typeof edits === "object" && !Array.isArray(edits)) edits = [edits];
      if (!Array.isArray(edits)) return r;
      const rest = without(r, ["edits", "changes", "replacements", "edit", ...SEARCH_KEYS, ...REPLACE_KEYS]);
      return { ...rest, edits: edits.map(oneEdit) };
    }
    case "run_command": {
      const c = pick(o, COMMAND_KEYS);
      const d = pick(o, CWD_KEYS);
      const r = without(o, [...COMMAND_KEYS, ...CWD_KEYS]);
      if (typeof c === "string") r.command = c;
      else if (Array.isArray(c) && c.every((x) => typeof x === "string")) r.command = c.join(" ");
      if (typeof d === "string" && d.trim() && d.trim() !== ".") r.cwd = projectPath(d, root);
      if (typeof r.timeout === "number" && r.timeout_seconds === undefined) {
        r.timeout_seconds = r.timeout;
        delete r.timeout;
      }
      return r;
    }
    case "search": {
      const p = pick(o, PATTERN_KEYS);
      const r = without(o, PATTERN_KEYS);
      if (typeof p === "string") r.pattern = p;
      if (typeof r.path === "string") r.path = projectPath(r.path, root);
      return r;
    }
    case "find_files": {
      const g = pick(o, GLOB_KEYS);
      const r = without(o, GLOB_KEYS);
      if (typeof g === "string") r.glob = g;
      return r;
    }
    default:
      return o;
  }
}
