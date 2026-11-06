import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventBus } from "../events/bus";
import type { ProjectService } from "../workspace/service";
import { buildDeck, DeckSpecSchema } from "./deck";

export interface DiagramFile {
  path: string;
  content: string;
  source: "project" | "workspace";
}
export interface DeckInfo {
  dir: string;
  title: string;
  kind: "pitch" | "progress";
  slides: number;
  files: string[];
  source: "project" | "workspace";
}

const MAX_FILE = 80_000;
const DIAGRAM_DIRS = ["docs/diagrams", "diagrams"];
const DIAGRAM_PATH = /^(docs\/diagrams|diagrams)\/[\w][\w .-]{0,80}\.(mmd|md)$/;

/**
 * Reads and writes the design artefacts of a project: Mermaid diagrams and slide decks. While a
 * task is still in review they live in its private workspace; after the change is applied they are
 * in the project folder. The user's own edits go straight to the project folder.
 */
export class DesignService {
  constructor(
    private readonly projects: ProjectService,
    private readonly workspaceRoot: (taskId: string) => string | null,
    private readonly bus: EventBus,
  ) {}

  private async roots(
    projectId: string,
    taskId?: string,
  ): Promise<{ root: string; source: "project" | "workspace" }[]> {
    const out: { root: string; source: "project" | "workspace" }[] = [];
    const ws = taskId ? this.workspaceRoot(taskId) : null;
    if (ws && fs.existsSync(ws)) out.push({ root: ws, source: "workspace" });
    const project = await this.projects.get(projectId);
    out.push({ root: project.rootPath, source: "project" });
    return out;
  }

  async listDiagrams(projectId: string, taskId?: string): Promise<DiagramFile[]> {
    const seen = new Map<string, DiagramFile>();
    for (const { root, source } of await this.roots(projectId, taskId)) {
      for (const dir of DIAGRAM_DIRS) {
        const abs = path.join(root, dir);
        if (!fs.existsSync(abs)) continue;
        for (const name of fs.readdirSync(abs).sort()) {
          const rel = `${dir}/${name}`;
          if (!DIAGRAM_PATH.test(rel) || seen.has(rel)) continue;
          try {
            const content = fs.readFileSync(path.join(abs, name), "utf8").slice(0, MAX_FILE);
            seen.set(rel, { path: rel, content, source });
          } catch {
            // unreadable: skip
          }
        }
      }
    }
    return [...seen.values()];
  }

  async saveDiagram(projectId: string, rel: string, content: string): Promise<{ path: string }> {
    const clean = rel.replace(/\\/g, "/");
    if (!DIAGRAM_PATH.test(clean))
      throw new Error("Diagrams are saved in docs/diagrams as .mmd or .md files.");
    if (content.length > MAX_FILE) throw new Error("The diagram is too large.");
    const project = await this.projects.get(projectId);
    const dest = path.join(project.rootPath, clean);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content.endsWith("\n") ? content : `${content}\n`);
    this.bus.emit({
      projectId,
      agent: "user",
      type: "writing_file",
      text: `Saved diagram ${clean}`,
      details: { path: clean },
      status: "succeeded",
    });
    return { path: clean };
  }

  private findDecks(root: string, source: "project" | "workspace"): DeckInfo[] {
    const out: DeckInfo[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === "deck.json")) {
        try {
          const spec = DeckSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "deck.json"), "utf8")));
          out.push({
            dir: path.relative(root, dir).replace(/\\/g, "/"),
            title: spec.title,
            kind: spec.kind,
            slides: spec.slides.length,
            files: entries
              .filter((e) => e.isFile() && /^deck\.(json|html|pptx|pdf)$/.test(e.name))
              .map((e) => e.name)
              .sort(),
            source,
          });
        } catch {
          // not a valid deck
        }
      }
      if (depth >= 3) return;
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
          walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(path.join(root, "docs"), 0);
    return out;
  }

  async listDecks(projectId: string, taskId?: string): Promise<DeckInfo[]> {
    const seen = new Map<string, DeckInfo>();
    for (const { root, source } of await this.roots(projectId, taskId)) {
      for (const d of this.findDecks(root, source)) if (!seen.has(d.dir)) seen.set(d.dir, d);
    }
    return [...seen.values()];
  }

  private async deckRoot(
    projectId: string,
    taskId: string | undefined,
    dir: string,
  ): Promise<{ root: string; abs: string }> {
    for (const { root } of await this.roots(projectId, taskId)) {
      const abs = path.resolve(root, dir);
      if (path.relative(root, abs).startsWith("..")) throw new Error("Invalid deck folder.");
      if (fs.existsSync(path.join(abs, "deck.json"))) return { root, abs };
    }
    throw new Error(`No deck found in ${dir}.`);
  }

  async deckHtml(projectId: string, taskId: string | undefined, dir: string): Promise<string> {
    const { abs } = await this.deckRoot(projectId, taskId, dir);
    return fs.readFileSync(path.join(abs, "deck.html"), "utf8");
  }

  async exportDeck(
    projectId: string,
    taskId: string | undefined,
    dir: string,
    format: "pptx" | "pdf" | "html",
    destDir?: string,
  ): Promise<{ path: string; bytes: number }> {
    const { root, abs } = await this.deckRoot(projectId, taskId, dir);
    let src = path.join(abs, `deck.${format}`);
    if (!fs.existsSync(src)) {
      // Rebuild from deck.json (adds the missing formats).
      const spec = DeckSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(abs, "deck.json"), "utf8")));
      await buildDeck(root, dir, spec);
      src = path.join(abs, `deck.${format}`);
      if (!fs.existsSync(src))
        throw new Error(`Could not make deck.${format} (a browser is needed for PDF).`);
    }
    const title = path.basename(dir) || "deck";
    const target = destDir?.trim() ? destDir : path.join(os.homedir(), "Downloads");
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
      throw new Error(`Export folder not found: ${target}`);
    let dest = path.join(target, `${title}.${format}`);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(target, `${title} (${i}).${format}`);
    fs.copyFileSync(src, dest);
    return { path: dest, bytes: fs.statSync(dest).size };
  }
}
