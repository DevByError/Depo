import { z } from "zod";

/**
 * Design references: the owner pastes or drops a picture, or pastes a link, and says "make it look
 * like this". Depo measures the colours (and, for a link, reads the page's real fonts and sizes),
 * asks the vision model for the layout and style, and gives every agent the result as a brief.
 */

export const REFERENCE_MAX_IMAGES = 4;
export const REFERENCE_MAX_LINKS = 2;
/** Largest picture accepted, in bytes before base64 (the UI shrinks bigger ones first). */
export const REFERENCE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const REFERENCE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const ReferenceImageMimeSchema = z.enum(REFERENCE_IMAGE_MIMES);
export type ReferenceImageMime = z.infer<typeof ReferenceImageMimeSchema>;

/** What the composer sends with a message. */
export const ReferenceInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      /** The file name, for display ("dashboard.png"). */
      name: z.string().min(1).max(200),
      mime: ReferenceImageMimeSchema,
      /** The picture, base64 without a data: prefix. */
      data: z
        .string()
        .min(8)
        .max(Math.ceil(REFERENCE_MAX_IMAGE_BYTES / 3) * 4 + 4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("link"),
      url: z.string().min(8).max(2000),
    })
    .strict(),
]);
export type ReferenceInput = z.infer<typeof ReferenceInputSchema>;

export const ReferenceInputsSchema = z
  .array(ReferenceInputSchema)
  .max(REFERENCE_MAX_IMAGES + REFERENCE_MAX_LINKS)
  .refine((a) => a.filter((r) => r.kind === "image").length <= REFERENCE_MAX_IMAGES, {
    message: `At most ${REFERENCE_MAX_IMAGES} pictures per message.`,
  })
  .refine((a) => a.filter((r) => r.kind === "link").length <= REFERENCE_MAX_LINKS, {
    message: `At most ${REFERENCE_MAX_LINKS} links per message.`,
  });

export const SwatchRoleSchema = z.enum([
  "background",
  "surface",
  "border",
  "text",
  "muted",
  "primary",
  "accent",
  "success",
  "warning",
  "danger",
]);
export type SwatchRole = z.infer<typeof SwatchRoleSchema>;

export const SwatchSchema = z.object({
  /** "#14b8a6". */
  hex: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Share of the picture (0..1); 0 for colours read from the page's CSS only. */
  share: z.number().min(0).max(1),
  role: SwatchRoleSchema.nullable(),
});
export type Swatch = z.infer<typeof SwatchSchema>;

export const ReferenceStateSchema = z.enum(["pending", "studied", "failed"]);

/** One reference as stored with the message and shown in the chat. */
export const DesignReferenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "link"]),
  /** File name for a picture, the host for a link. */
  name: z.string().max(200),
  url: z.string().max(2000).nullable(),
  state: ReferenceStateSchema,
  /** A screenshot or the picture itself (shown with references.image). */
  hasImage: z.boolean(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Light or dark, from the background. */
  mode: z.enum(["light", "dark"]).nullable(),
  palette: z.array(SwatchSchema).max(14),
  /** Font families, the most used first (read from the page for a link, a guess for a picture). */
  fonts: z.array(z.string().max(120)).max(4),
  /** Most common corner radius, e.g. "12px". */
  radius: z.string().max(40).nullable(),
  /** What the vision model saw: layout, typography, shapes, components, mood. Short lines. */
  notes: z.array(z.string().max(300)).max(16),
  /** True when the vision model looked at it. */
  vision: z.boolean(),
  /** Plain warnings ("No vision model is set up, so only the colours were measured."). */
  warnings: z.array(z.string().max(300)).max(6),
  error: z.string().max(400).nullable(),
});
export type DesignReference = z.infer<typeof DesignReferenceSchema>;

export const ReferenceMethods = {
  /** The picture or screenshot of a reference, for the chat (base64). */
  "references.image": {
    params: z.object({ taskId: z.string().min(1).max(64), id: z.string().min(1).max(64) }).strict(),
    result: z.object({ mime: z.string(), data: z.string() }),
  },
} as const;

/** "https://www.example.com/pricing" -> "example.com". */
export function referenceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url.slice(0, 60);
  }
}
