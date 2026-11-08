import fs from "node:fs";
import path from "node:path";
import { normalizeArgs, projectPath } from "../tools/args";

/**
 * Small models make up tool names that say what they mean: create_file, cat, ls, str_replace,
 * add_table, create_table_skills, exec. When the meaning and the arguments are clear, Depo runs
 * the real tool and tells the model which one it ran; otherwise the call stays unknown and the
 * model is told its real tools. A made-up call that would replace an existing file with a part
 * of it is never guessed.
 */

type Args = Record<string, unknown>;

const PATH_KEYS = ["path", "file", "filename", "file_name", "filepath", "file_path", "target_file", "target"];
const CONTENT_KEYS = ["content", "contents", "text", "code", "body", "data", "source", "file_content", "sql"];

function str(a: Args, keys: string[]): string | undefined {
  for (const k of keys) if (typeof a[k] === "string" && (a[k] as string).trim()) return a[k] as string;
  return undefined;
}

const READ =
  /^(cat|type|read|open|view|show|get|load|print)(_?(the_)?file(_?contents?)?s?)?$|^(read|open|view|get|show)_\w*file\w*$|^file_read$/;
const LIST =
  /^(ls|dir|tree|list(_?(dir|dirs|directory|directories|files|folder|folders|contents|project|tables))?|list_project_files|show_files|get_files|view_dir|browse)$/;
const RUN =
  /^(exec|execute|shell|bash|sh|cmd|terminal|powershell|run|run_shell|run_cmd|run_bash|run_terminal|run_terminal_command|run_shell_command|execute_command|execute_shell|exec_command|shell_exec|command)$/;
const SEARCH =
  /^(grep|rg|ripgrep|search_code|search_files|search_text|search_in_files|find_in_files|grep_search|code_search|text_search)$/;
const FIND = /^(glob|find|locate|find_file|file_search|search_file|search_filenames|find_by_name)$/;
const EDIT =
  /^(edit|replace|str_replace|str_replace_editor|replace_in_file|replace_text|modify|modify_file|update_file|update|patch|patch_file|apply_patch|apply_edit|search_replace|search_and_replace|find_and_replace|edit_code|change_file|apply_diff|insert_code)$/;
const APPEND = /(^|_)(append|add|insert)(_|$)|create_table|add_table|add_column|add_route|add_section/;
const WRITE =
  /^(create|write|save|make|new|put|touch|generate)(_?(new_)?(file|code|module|component|page|script|source))?$|^(create|write|save)_\w+$|^file_write$/;
const DELETE = /^(rm|del|delete|remove|unlink)(_?file)?$/;

/** The real tool and arguments a made-up call stands for, or null when it is not clear. */
export function aliasFor(
  name: string,
  rawArgs: unknown,
  known: Set<string>,
  root?: string,
): { name: string; args: unknown } | null {
  if (known.has(name)) return null;
  const n = name
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
  let a: Args = {};
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) a = rawArgs as Args;
  else if (typeof rawArgs === "string") {
    try {
      const j = JSON.parse(rawArgs);
      if (j && typeof j === "object" && !Array.isArray(j)) a = j as Args;
    } catch {
      // not JSON: some made-up tools take one plain string (a command, a path)
      a = { _: rawArgs };
    }
  }
  const p = str(a, PATH_KEYS);
  const content = str(a, CONTENT_KEYS);
  const mode = String(a.mode ?? a.action ?? a.operation ?? "").toLowerCase();
  const to = (tool: string, args: Args) =>
    known.has(tool) ? { name: tool, args: normalizeArgs(tool, args, root) } : null;
  const exists = (rel: string) => {
    if (!root) return false;
    try {
      return fs.existsSync(path.join(root, projectPath(rel, root)));
    } catch {
      return false;
    }
  };

  if (READ.test(n) && (p || typeof a._ === "string") && !content)
    return to("read_file", { ...a, path: p ?? a._ });
  if (LIST.test(n) && !content)
    return to("list_dir", { path: p ?? str(a, ["dir", "directory", "folder"]) ?? "." });
  if (RUN.test(n)) {
    const command = str(a, ["command", "cmd", "script", "shell_command", "code", "_"]);
    return command ? to("run_command", { ...a, command }) : null;
  }
  if (SEARCH.test(n)) {
    const pattern = str(a, ["pattern", "query", "regex", "text", "search", "term", "_"]);
    return pattern ? to("search", { ...a, pattern }) : null;
  }
  if (FIND.test(n)) {
    const glob = str(a, ["glob", "pattern", "name", "query", "_"]);
    return glob ? to("find_files", { glob }) : null;
  }
  if (DELETE.test(n) && p && !content) return to("delete_file", { path: p });
  if (EDIT.test(n) || Array.isArray(a.edits)) {
    const hasSearch = ["search", "old_str", "old_string", "old", "old_text", "find", "original"].some(
      (k) => typeof a[k] === "string",
    );
    if (p && (hasSearch || a.edits !== undefined)) return to("edit_file", a);
    // Whole content under an "update" name: only safe for a file that is not there yet.
    if (p && content && !exists(p)) return to("write_file", { path: p, content });
    if (p && content && (mode === "append" || mode === "add")) return to("append_file", { path: p, content });
    return null;
  }
  if (!p || !content) return null;
  if (mode === "append" || mode === "add" || APPEND.test(n)) return to("append_file", { path: p, content });
  if (WRITE.test(n) || mode === "write" || mode === "create" || mode === "overwrite")
    return to("write_file", { path: p, content });
  return null;
}

/** What the model reads before the result of a call Depo ran under its real name. */
export function aliasNote(from: string, to: string): string {
  return `Note from Depo: there is no tool "${from}", so Depo ran ${to} with your arguments. Call ${to} by its own name next time.`;
}
