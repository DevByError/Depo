import { z } from "zod";

/**
 * Blueprints: tested, production-minded starting points (an API, a web app, both together) that
 * agents extend instead of starting from a blank page. A blueprint writes a whole project; a
 * building block adds one piece to a project that already exists.
 */

export const BlueprintIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "A blueprint id is lower case letters, digits and dashes.");

export const BlueprintSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  /** One line for cards. */
  summary: z.string(),
  /** Short stack tags, e.g. ["Python", "FastAPI", "SQLite"]. */
  stack: z.array(z.string()),
  /** "What you get": plain lines. */
  features: z.array(z.string()),
  /** How to start it (from the project folder). */
  runCommand: z.string(),
  /** How to run its own tests (from the project folder). */
  testCommand: z.string(),
  /** Local ports it listens on when running. */
  ports: z.array(z.number().int()),
  /** Where things go and how to add a resource end to end; written for agents, kept short. */
  extendGuide: z.string(),
  fileCount: z.number().int(),
});
export type BlueprintSummary = z.infer<typeof BlueprintSummarySchema>;

export const BlueprintFileInfoSchema = z.object({ path: z.string(), size: z.number().int() });
export type BlueprintFileInfo = z.infer<typeof BlueprintFileInfoSchema>;

export const BlueprintDetailSchema = BlueprintSummarySchema.extend({
  /** Every file it writes, sorted by path, with its size in bytes (for the name "my-app"). */
  files: z.array(BlueprintFileInfoSchema),
  totalBytes: z.number().int(),
});
export type BlueprintDetail = z.infer<typeof BlueprintDetailSchema>;

/** What happened with git when a project was created from a blueprint. */
export const BlueprintGitSchema = z.enum(["committed", "initialized", "skipped"]);
export type BlueprintGit = z.infer<typeof BlueprintGitSchema>;

/** The same rules as a new project's name (rpc.ts): it becomes a folder name on Windows. */
const ProjectNameParam = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in Windows file names
  .regex(/^[^<>:"/\\|?*\x00-\x1f]+$/, 'A project name cannot contain < > : " / \\ | ? *')
  .refine((n) => !/[. ]$/.test(n), "A project name cannot end with a dot or a space");

/**
 * The RPC methods. `blueprints.create` returns the new project, so the contract takes the project
 * schema from rpc.ts as an argument (importing it here would make a module cycle).
 */
export function blueprintMethods<P extends z.ZodType>(projectSchema: P) {
  return {
    "blueprints.list": {
      params: z.object({}).strict(),
      result: z.object({ blueprints: z.array(BlueprintSummarySchema) }),
    },
    "blueprints.get": {
      params: z.object({ id: BlueprintIdSchema }).strict(),
      result: BlueprintDetailSchema,
    },
    "blueprints.create": {
      params: z
        .object({
          id: BlueprintIdSchema,
          parentDir: z.string().min(1).max(1000),
          name: ProjectNameParam,
          description: z.string().max(2000).optional(),
          /** Start a git repository with a first commit when git is installed (default true). */
          initGit: z.boolean().optional(),
        })
        .strict(),
      result: z.object({
        project: projectSchema,
        /** Files the blueprint has; the first task writes them into its private copy (the folder gets only a README). */
        files: z.number().int(),
        git: BlueprintGitSchema,
      }),
    },
  } as const;
}
