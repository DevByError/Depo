import fs from "node:fs";
import path from "node:path";

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** SKILL.md: YAML front matter with `name` and `description`, then the instructions in Markdown. */
export function parseSkillMd(text: string): ParsedSkill {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) throw new Error("SKILL.md must start with a front matter block (--- name: … description: … ---).");
  const meta: Record<string, string> = {};
  const lines = (m[1] ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    let v = (kv[2] ?? "").trim();
    // Folded or literal block scalars: take the indented lines that follow.
    if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) parts.push((lines[++i] ?? "").trim());
      v = parts.join(v.startsWith(">") ? " " : "\n");
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1].toLowerCase()] = v;
  }
  const name = (meta.name ?? "").trim();
  const description = (meta.description ?? "").trim();
  if (!NAME.test(name)) {
    throw new Error(
      `The skill name "${name}" is not valid. Use lowercase letters, digits and dashes (up to 64).`,
    );
  }
  if (!description)
    throw new Error("SKILL.md needs a description: it tells the agent when to use the skill.");
  if (description.length > 1024) throw new Error("The skill description is longer than 1024 characters.");
  const body = (m[2] ?? "").trim();
  if (!body) throw new Error("SKILL.md has no instructions after the front matter.");
  return { name, description, body };
}

/** Find every folder in a tree that holds a SKILL.md (a repository may contain many skills). */
export function findSkillDirs(root: string, subpath = "", maxDepth = 6): string[] {
  const out: string[] = [];
  const start = path.join(root, subpath);
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(path.relative(root, dir).replace(/\\/g, "/") || ".");
      return; // a skill folder is a leaf: its sub-folders are its resources
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(start, 0);
  return out.sort();
}

export function listSkillFiles(dir: string, limit = 200): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  try {
    walk(dir);
  } catch {
    // unreadable: return what we have
  }
  return out.sort();
}
