import {
  REFERENCE_IMAGE_MIMES,
  REFERENCE_MAX_IMAGE_BYTES,
  REFERENCE_MAX_IMAGES,
  REFERENCE_MAX_LINKS,
  type ReferenceImageMime,
  type ReferenceInput,
  referenceHost,
} from "@depo/shared";

/**
 * Design references in the composer: pictures pasted, dropped or picked, and links. A picture is
 * sent as it is when it is small (exact colours); a big one is shrunk in the browser first.
 */

export interface DraftReference {
  key: string;
  input: ReferenceInput;
  /** File name, or the link's host. */
  name: string;
  /** Object URL of the picture for the thumbnail (revoke when removed). */
  preview: string | null;
}

/** Pictures up to this size are sent untouched. */
const KEEP_BYTES = 3 * 1024 * 1024;
/** Longest side after shrinking. */
const MAX_SIDE = 2400;

const MIMES = new Set<string>(REFERENCE_IMAGE_MIMES);

export function isPicture(file: { type: string }): boolean {
  return MIMES.has(file.type);
}

/** Links typed in a message: unique, without trailing punctuation, at most 3. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, "");
    if (!out.includes(url)) out.push(url);
    if (out.length === 3) break;
  }
  return out;
}

/** A plain link the owner typed into the link field: adds https:// when missing. */
export function normaliseLink(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Why another reference of this kind cannot be added, or null. */
export function limitReason(drafts: DraftReference[], kind: "image" | "link"): string | null {
  const n = drafts.filter((d) => d.input.kind === kind).length;
  if (kind === "image" && n >= REFERENCE_MAX_IMAGES)
    return `You can send up to ${REFERENCE_MAX_IMAGES} pictures with one message.`;
  if (kind === "link" && n >= REFERENCE_MAX_LINKS)
    return `You can send up to ${REFERENCE_MAX_LINKS} links with one message.`;
  return null;
}

export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("The picture could not be read."));
    r.readAsDataURL(blob);
  });
}

/** Shrink a big picture to at most MAX_SIDE on the long side; PNG when it fits, otherwise JPEG. */
async function shrink(file: Blob): Promise<{ blob: Blob; mime: string }> {
  if (typeof createImageBitmap !== "function") throw new Error("This picture is too large.");
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This picture is too large.");
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const toBlob = (type: string, q?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));
  const pngBlob = await toBlob("image/png");
  if (pngBlob && pngBlob.size <= REFERENCE_MAX_IMAGE_BYTES * 0.9) return { blob: pngBlob, mime: "image/png" };
  const jpg = await toBlob("image/jpeg", 0.9);
  if (!jpg || jpg.size > REFERENCE_MAX_IMAGE_BYTES)
    throw new Error("This picture is too large, even after shrinking it.");
  return { blob: jpg, mime: "image/jpeg" };
}

let seq = 0;
const nextKey = () => `draft-${++seq}`;

/** A picture from a paste, a drop or the file picker, ready to send. */
export async function pictureDraft(file: File | Blob, name?: string): Promise<DraftReference> {
  if (!isPicture(file))
    throw new Error("Only PNG, JPEG, WebP or GIF pictures can be used as a design reference.");
  const fileName =
    (name ?? (file as File).name ?? "").trim() || `pasted picture.${file.type.split("/")[1] ?? "png"}`;
  let blob: Blob = file;
  let mime = file.type;
  if (file.size > KEEP_BYTES) ({ blob, mime } = await shrink(file));
  const data = await base64Of(blob);
  const preview = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
  return {
    key: nextKey(),
    input: { kind: "image", name: fileName.slice(0, 200), mime: mime as ReferenceImageMime, data },
    name: fileName,
    preview,
  };
}

export function linkDraft(url: string): DraftReference {
  return { key: nextKey(), input: { kind: "link", url }, name: referenceHost(url), preview: null };
}

export function releaseDraft(d: DraftReference): void {
  if (d.preview && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(d.preview);
}

/** What to send when the owner attached references but wrote nothing. */
export const DEFAULT_REFERENCE_TEXT = "Use the same UI/UX and theme as the attached reference.";

/** "dark theme · Inter · 12px corners". */
export function referenceSummary(r: { mode: string | null; fonts: string[]; radius: string | null }): string {
  return [r.mode && `${r.mode} theme`, r.fonts[0], r.radius && `${r.radius} corners`]
    .filter(Boolean)
    .join(" · ");
}
