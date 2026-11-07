import { z } from "zod";

/**
 * Previews: Depo starts the app it builds (from the real project folder or from a task's private
 * copy) on 127.0.0.1 and gives the owner a link. Recipes say how to start a folder.
 */

export const RecipeKindSchema = z.enum([
  "node",
  "next",
  "vite",
  "bun",
  "fastapi",
  "flask",
  "django",
  "static",
  "custom",
  "both",
]);
export type RecipeKind = z.infer<typeof RecipeKindSchema>;

export const RecipeRoleSchema = z.enum(["app", "frontend", "backend"]);
export type RecipeRole = z.infer<typeof RecipeRoleSchema>;

/** Packages the app needs are not installed yet, and the command that would install them. */
export const MissingDepsSchema = z.object({
  reason: z.string().max(500),
  install: z.string().max(2000),
  /** Folder the install runs in, relative to the target root ("" = root). */
  cwd: z.string().max(500),
});
export type MissingDeps = z.infer<typeof MissingDepsSchema>;

const RecipeFields = {
  /** Stable within one detection, e.g. `vite:frontend` or `custom`. */
  id: z.string().min(1).max(200),
  kind: RecipeKindSchema,
  label: z.string().max(200),
  /**
   * The start command. `{port}` is replaced with the chosen port (and `{backend_url}` with the
   * backend's address when frontend and backend start together). Empty for the built-in static server.
   */
  command: z.string().max(2000),
  /** Folder to run in, relative to the target root ("" = root), with forward slashes. */
  cwd: z.string().max(500),
  env: z.record(z.string().max(100), z.string().max(2000)),
  /** Preferred port; another free one is used when it is taken. 0 = any free port. */
  port: z.number().int().min(0).max(65535),
  /** Path polled until the app answers. */
  readyPath: z.string().max(500),
  role: RecipeRoleSchema,
  missing: MissingDepsSchema.nullable(),
};

export const RunRecipeBaseSchema = z.object(RecipeFields);
export type RunRecipeBase = z.infer<typeof RunRecipeBaseSchema>;

export const RunRecipeSchema = z.object({
  ...RecipeFields,
  /** For kind `both`: the recipes started together, backend first. */
  parts: z.array(RunRecipeBaseSchema).max(4).optional(),
});
export type RunRecipe = z.infer<typeof RunRecipeSchema>;

export const PreviewStateSchema = z.enum(["starting", "running", "failed", "stopped"]);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const PreviewInfoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Set when the preview runs a task's private copy instead of the real project folder. */
  taskId: z.string().nullable(),
  target: z.enum(["project", "workspace"]),
  kind: RecipeKindSchema,
  label: z.string(),
  role: RecipeRoleSchema,
  /** The command as it runs, with the port filled in ("" for the built-in static server). */
  command: z.string(),
  cwd: z.string(),
  port: z.number().int(),
  url: z.string(),
  state: PreviewStateSchema,
  /** What is happening now, in plain words. */
  phase: z.string(),
  error: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  /** `user` or the agent tag that started it. */
  startedBy: z.string(),
  /** Previews started together (frontend and backend) share a group. */
  groupId: z.string().nullable(),
  /** An approval the preview is waiting for (installing packages). */
  approvalId: z.string().nullable(),
  startedAt: z.string(),
  readyAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  /** Started by Depo when the task's changes were ready for review (preview.autoStart). */
  auto: z.boolean().optional(),
  /** The owner asked to keep it running after the changes are applied or discarded. */
  pinned: z.boolean().optional(),
});
export type PreviewInfo = z.infer<typeof PreviewInfoSchema>;

export const PreviewLogLineSchema = z.object({
  seq: z.number().int(),
  /** `out` and `err` come from the app; `depo` lines are Depo's own notes. */
  stream: z.enum(["out", "err", "depo"]),
  text: z.string(),
});
export type PreviewLogLine = z.infer<typeof PreviewLogLineSchema>;

export const PreviewDetectionSchema = z.object({
  target: z.enum(["project", "workspace"]),
  root: z.string(),
  recipes: z.array(RunRecipeSchema),
  /** Index into `recipes` of the one Depo would start (the project's own command when set), or -1. */
  suggested: z.number().int(),
  /** The project's saved start command ("" when none). */
  override: z.string(),
  /** Plain hints, e.g. why nothing was found. */
  notes: z.array(z.string()),
});
export type PreviewDetection = z.infer<typeof PreviewDetectionSchema>;

export const PreviewTargetSchema = z.object({
  taskId: z.string().nullable(),
  label: z.string(),
  status: z.string().nullable(),
});
export type PreviewTarget = z.infer<typeof PreviewTargetSchema>;

export const PreviewMethods = {
  "preview.targets": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ targets: z.array(PreviewTargetSchema) }),
  },
  "preview.detect": {
    params: z.object({ projectId: z.string(), taskId: z.string().optional() }).strict(),
    result: PreviewDetectionSchema,
  },
  "preview.start": {
    params: z
      .object({
        projectId: z.string(),
        taskId: z.string().optional(),
        /** What to start; the suggested recipe when left out. */
        recipe: RunRecipeSchema.optional(),
        /** Install missing packages first (asks the user for approval). */
        install: z.boolean().optional(),
      })
      .strict(),
    result: z.object({ preview: PreviewInfoSchema, related: z.array(PreviewInfoSchema) }),
  },
  "preview.stop": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ stopped: z.boolean() }),
  },
  "preview.restart": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ preview: PreviewInfoSchema }),
  },
  "preview.list": {
    params: z.object({ projectId: z.string().optional() }).strict(),
    result: z.object({ previews: z.array(PreviewInfoSchema) }),
  },
  "preview.logs": {
    params: z.object({ id: z.string(), since: z.number().int().min(0).optional() }).strict(),
    result: z.object({
      lines: z.array(PreviewLogLineSchema),
      /** Pass as `since` next time to get only newer lines. */
      next: z.number().int(),
      /** Older lines were dropped from the buffer since the last call. */
      dropped: z.boolean(),
      state: PreviewStateSchema,
    }),
  },
} as const;
