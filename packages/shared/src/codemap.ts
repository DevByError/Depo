import { z } from "zod";

/**
 * The code map: how a project's files and folders depend on each other, read from the code index
 * (imports between files, sizes, symbols, a simple branch count) plus git history when there is one.
 * Modules are folders, grouped so a big project still reads at a glance.
 */

/** What a folder is mostly for; the UI colours modules by it. */
export const CodeAreaSchema = z.enum(["ui", "server", "data", "tests", "tooling", "docs", "core", "other"]);
export type CodeArea = z.infer<typeof CodeAreaSchema>;

export const CodeMapLevelSchema = z.enum(["module", "file"]);
export type CodeMapLevel = z.infer<typeof CodeMapLevelSchema>;

export const CodeMapNodeSchema = z.object({
  /** A folder path for a module ("" = the top level), a file path for a file. */
  id: z.string(),
  label: z.string(),
  kind: z.enum(["module", "file"]),
  area: CodeAreaSchema,
  files: z.number().int(),
  lines: z.number().int(),
  symbols: z.number().int(),
  branches: z.number().int(),
  /** Distinct modules (or files) this one imports. */
  importsOut: z.number().int(),
  /** Distinct modules (or files) that import this one. */
  importedBy: z.number().int(),
  inCycle: z.boolean(),
  /** Holds an entry point (or is one). */
  entry: z.boolean(),
  /** For a file: its module. For a module: null. */
  module: z.string().nullable(),
  /** A neighbour outside the focused folder, shown for context. */
  outside: z.boolean(),
});
export type CodeMapNode = z.infer<typeof CodeMapNodeSchema>;

export const CodeMapEdgeSchema = z.object({
  /** The importer. */
  from: z.string(),
  /** What it imports. */
  to: z.string(),
  /** How many file-level imports the edge stands for. */
  weight: z.number().int(),
  /** Part of an import cycle. */
  cycle: z.boolean(),
});
export type CodeMapEdge = z.infer<typeof CodeMapEdgeSchema>;

export const CodeHotSpotSchema = z.object({
  path: z.string(),
  value: z.number(),
  /** Plain words, e.g. "31 files import it" or "719 lines, 40 symbols". */
  detail: z.string(),
});
export type CodeHotSpot = z.infer<typeof CodeHotSpotSchema>;

export const CodeEntryPointSchema = z.object({ path: z.string(), reason: z.string() });
export type CodeEntryPoint = z.infer<typeof CodeEntryPointSchema>;

export const CodeMapSummarySchema = z.object({
  /** Source files (code, styles, markup) in the map. */
  files: z.number().int(),
  lines: z.number().int(),
  symbols: z.number().int(),
  /** Imports between project files. */
  edges: z.number().int(),
  modules: z.number().int(),
  languages: z.array(z.object({ name: z.string(), files: z.number().int(), lines: z.number().int() })),
  /** Outside libraries the code imports most (react, fastapi...). */
  libraries: z.array(z.object({ name: z.string(), count: z.number().int() })),
});
export type CodeMapSummary = z.infer<typeof CodeMapSummarySchema>;

export const CodeMapSchema = z.object({
  projectId: z.string(),
  level: CodeMapLevelSchema,
  focus: z.string().nullable(),
  summary: CodeMapSummarySchema,
  nodes: z.array(CodeMapNodeSchema),
  edges: z.array(CodeMapEdgeSchema),
  /**
   * Import cycles between files (each a list of file paths), largest first. Only imports that exist
   * at runtime count (TypeScript `import type` does not). Modules and edges they cross are flagged.
   */
  cycles: z.array(z.array(z.string())),
  entryPoints: z.array(CodeEntryPointSchema),
  hotSpots: z.object({
    /** Files the most other files import. */
    dependedOn: z.array(CodeHotSpotSchema),
    largest: z.array(CodeHotSpotSchema),
    /** Most branches (if, loops, case, catch, && and ||). */
    complex: z.array(CodeHotSpotSchema),
    /** Changed in the most commits (git projects only). */
    churn: z.array(CodeHotSpotSchema),
  }),
  /** More nodes exist than are shown. */
  truncated: z.boolean(),
  /** The code index is still being built. */
  indexing: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type CodeMap = z.infer<typeof CodeMapSchema>;

export const CodeFileInfoSchema = z.object({
  path: z.string(),
  module: z.string(),
  area: CodeAreaSchema,
  lang: z.string().nullable(),
  lines: z.number().int(),
  branches: z.number().int(),
  entry: z.string().nullable(),
  inCycle: z.boolean(),
  /** Commits that changed it (git projects), else null. */
  churn: z.number().int().nullable(),
  imports: z.array(
    z.object({
      spec: z.string(),
      line: z.number().int(),
      kind: z.string(),
      /** The project file it resolves to. */
      target: z.string().nullable(),
      /** The outside library it names, when it is not a project file. */
      library: z.string().nullable(),
    }),
  ),
  importedBy: z.array(z.object({ path: z.string(), line: z.number().int() })),
  symbols: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      parent: z.string().nullable(),
      startLine: z.number().int(),
      endLine: z.number().int(),
      signature: z.string(),
    }),
  ),
});
export type CodeFileInfo = z.infer<typeof CodeFileInfoSchema>;

export const RepoInfoSchema = z.object({
  stack: z.object({
    /** One line, e.g. "Python, FastAPI, PostgreSQL". */
    summary: z.string(),
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    databases: z.array(z.string()),
    tools: z.array(z.string()),
    packageManager: z.string().nullable(),
    testCommand: z.string().nullable(),
    runCommand: z.string().nullable(),
  }),
  git: z
    .object({
      branch: z.string().nullable(),
      /** Files with changes not committed yet (staged, changed or new). */
      changed: z.number().int(),
      ahead: z.number().int(),
      behind: z.number().int(),
      lastCommit: z.object({ hash: z.string(), date: z.string(), subject: z.string() }).nullable(),
    })
    .nullable(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const CodeMapMethods = {
  "codemap.get": {
    params: z
      .object({
        projectId: z.string(),
        level: CodeMapLevelSchema,
        /** A folder to zoom into (module or file level) or a file to centre on (file level). */
        focus: z.string().max(500).optional(),
      })
      .strict(),
    result: CodeMapSchema,
  },
  "codemap.file": {
    params: z.object({ projectId: z.string(), path: z.string().min(1).max(1000) }).strict(),
    result: CodeFileInfoSchema,
  },
  "codemap.repo": {
    params: z.object({ projectId: z.string() }).strict(),
    result: RepoInfoSchema,
  },
} as const;
