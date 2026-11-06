import { z } from "zod";

/** Phase 5: skills, MCP servers and knowledge packs. */

export const VetFindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  rule: z.string(),
  file: z.string(),
  line: z.number().int(),
  text: z.string(),
});
export const VetReportSchema = z.object({
  verdict: z.enum(["clean", "warnings", "blocked"]),
  findings: z.array(VetFindingSchema),
  files: z.number().int(),
  scripts: z.number().int(),
  scannedAt: z.string(),
  review: z.string().optional(),
});
export type VetReportDto = z.infer<typeof VetReportSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  sourceKind: z.enum(["github", "zip", "folder", "created"]),
  source: z.string(),
  ref: z.string().nullable(),
  commit: z.string().nullable(),
  versionId: z.string(),
  versions: z.array(
    z.object({ id: z.string(), commit: z.string().nullable(), ref: z.string().nullable(), at: z.string() }),
  ),
  enabled: z.boolean(),
  vetting: VetReportSchema,
  assignments: z.array(
    z.object({ scope: z.enum(["global", "project"]), projectId: z.string().nullable(), agent: z.string() }),
  ),
  files: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillDto = z.infer<typeof SkillSchema>;

export const SkillCandidateSchema = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string(),
  error: z.string().nullable(),
  installed: z.boolean(),
});

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  command: z.string().nullable(),
  args: z.array(z.string()),
  envKeys: z.array(z.string()),
  url: z.string().nullable(),
  enabled: z.boolean(),
  autoApprove: z.boolean(),
  vetting: VetReportSchema.nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() })),
  status: z.enum(["stopped", "running"]),
  createdAt: z.string(),
});
export type McpServerDto = z.infer<typeof McpServerSchema>;

export const KnowledgePackSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  kind: z.enum(["docs", "security", "ux", "custom"]),
  source: z.string(),
  description: z.string(),
  docCount: z.number().int(),
  chunkCount: z.number().int(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type KnowledgePackDto = z.infer<typeof KnowledgePackSchema>;

export const KnowledgeCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["docs", "security", "ux", "custom"]),
  description: z.string(),
  url: z.string(),
  extensions: z.array(z.string()),
  verified: z.boolean(),
  approxSizeMb: z.number(),
  installed: z.boolean(),
});

export const KnowledgeHitSchema = z.object({
  pack: z.string(),
  version: z.string(),
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});

export const OsvStatusSchema = z.object({
  ecosystem: z.string(),
  count: z.number().int(),
  importedAt: z.string(),
  source: z.string(),
});

export const ScoreSchema = z.object({
  overall: z.number(),
  grade: z.string(),
  blocksRelease: z.boolean(),
  at: z.string(),
});

export const SecurityFindingSchema = z.object({
  tool: z.string(),
  rule: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
  fix: z.string(),
});

export const SecurityReportSchema = z.object({
  at: z.string(),
  findings: z.array(SecurityFindingSchema),
  score: z.object({
    overall: z.number(),
    grade: z.string(),
    blocksRelease: z.boolean(),
    counts: z.record(z.string(), z.number()),
    reasons: z.array(z.string()),
  }),
  ran: z.array(z.object({ tool: z.string(), note: z.string() })),
  skipped: z.array(z.object({ tool: z.string(), install: z.string() })),
});
export type SecurityReport = z.infer<typeof SecurityReportSchema>;
