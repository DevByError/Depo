import { z } from "zod";

/**
 * Git: turn changes the owner applied into clean commits, and read the project's history.
 * Depo commits only the files it applied, on the owner's click, and never pushes.
 */

/** Same shape as the change-set hunk (rpc.ts); declared here so this file does not import rpc.ts. */
const HunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(z.string()),
});

export const GitIdentitySchema = z.object({ name: z.string(), email: z.string() });
export type GitIdentity = z.infer<typeof GitIdentitySchema>;

export const GitStatusSchema = z.object({
  /** Git is installed and runs. */
  gitAvailable: z.boolean(),
  isRepo: z.boolean(),
  /** Current branch; null when HEAD is detached or this is not a repository. */
  branch: z.string().nullable(),
  detached: z.boolean(),
  /** The repository has no commits yet. */
  unborn: z.boolean(),
  /** Files with changes that are not committed (staged, unstaged or new). */
  changes: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  /** The first changed files, with their two-letter porcelain code (` M`, `??`, `A `…). */
  entries: z.array(z.object({ path: z.string(), code: z.string() })),
  /** user.name and user.email as git sees them here; null when either is missing. */
  identity: GitIdentitySchema.nullable(),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitDraftFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Committed by default. */
  include: z.boolean(),
  /** Why the file needs a look or is left out, in plain words; null when all is well. */
  note: z.string().nullable(),
});
export type GitDraftFile = z.infer<typeof GitDraftFileSchema>;

export const GitCommitRefSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  branch: z.string().nullable(),
});
export type GitCommitRef = z.infer<typeof GitCommitRefSchema>;

export const GitDraftSchema = z.object({
  /** Conventional commit: `type(scope): summary`, a blank line, then a short body. */
  message: z.string(),
  /** Who wrote the draft: a local model, or Depo's own template when no model answered. */
  source: z.enum(["model", "template"]),
  /** A short note about the draft (for example why the template was used), or null. */
  note: z.string().nullable(),
  files: z.array(GitDraftFileSchema),
  branch: z.string().nullable(),
  /** `depo/<short-task-slug>`, free to create. */
  suggestedBranch: z.string(),
  identity: GitIdentitySchema.nullable(),
  /** This change set was already committed by Depo. */
  committed: GitCommitRefSchema.nullable(),
});
export type GitDraft = z.infer<typeof GitDraftSchema>;

export const GitCommitSummarySchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  body: z.string(),
  author: z.string(),
  email: z.string(),
  /** ISO time the commit was authored. */
  date: z.string(),
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type GitCommitSummary = z.infer<typeof GitCommitSummarySchema>;

export const GitFileDiffSchema = z.object({
  path: z.string(),
  /** For renames and copies: the old path. */
  oldPath: z.string().nullable(),
  kind: z.enum(["added", "modified", "deleted", "renamed"]),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(HunkSchema),
  /** The diff of this file was cut to keep the answer small. */
  truncated: z.boolean(),
});
export type GitFileDiff = z.infer<typeof GitFileDiffSchema>;

/** `depo/…` and other ordinary branch names; git checks the rest (check-ref-format). */
export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use letters, digits, dots, dashes, underscores and slashes.");

export const GitMethods = {
  "git.status": {
    params: z.object({ projectId: z.string().max(100) }).strict(),
    result: GitStatusSchema,
  },
  "git.draftCommit": {
    params: z
      .object({
        projectId: z.string().max(100),
        changeSetId: z.string().max(100),
        /** Ask a local model for the message (background priority). False = Depo's template, at once. */
        model: z.boolean().default(true),
      })
      .strict(),
    result: GitDraftSchema,
  },
  "git.commit": {
    params: z
      .object({
        projectId: z.string().max(100),
        changeSetId: z.string().max(100),
        message: z.string().min(1).max(10_000),
        /** Create this branch from the current commit first, then commit there. */
        branch: GitBranchNameSchema.optional(),
        /** Only these applied files (default: every applied file that still has changes). */
        files: z.array(z.string().max(1000)).max(2000).optional(),
      })
      .strict(),
    result: z.object({
      hash: z.string(),
      shortHash: z.string(),
      branch: z.string().nullable(),
      createdBranch: z.boolean(),
      files: z.array(z.string()),
      /** Applied files that were not committed, and why. */
      skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
  },
  "git.log": {
    params: z
      .object({ projectId: z.string().max(100), limit: z.number().int().min(1).max(200).default(30) })
      .strict(),
    result: z.object({ commits: z.array(GitCommitSummarySchema) }),
  },
  "git.show": {
    params: z
      .object({ projectId: z.string().max(100), hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/) })
      .strict(),
    result: z.object({ commit: GitCommitSummarySchema, files: z.array(GitFileDiffSchema) }),
  },
  "git.setIdentity": {
    // Sets user.name and user.email for this repository only (git config --local).
    params: z
      .object({
        projectId: z.string().max(100),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().min(3).max(200),
      })
      .strict(),
    result: z.object({ identity: GitIdentitySchema }),
  },
} as const;
