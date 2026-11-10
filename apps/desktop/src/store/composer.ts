import type { WorkMode } from "@depo/shared";
import { create } from "zustand";
import type { DraftReference } from "@/lib/references";

/**
 * Text waiting for the chat composer ("Change this" in Files, and any other screen that wants to
 * start a message for the owner). The composer takes it once, puts the caret where asked and clears it.
 */
export interface ComposerPrefill {
  text: string;
  /** Caret position in `text` (defaults to the end). */
  cursor: number;
  /** Work mode for a new task; null keeps the composer's choice. */
  mode: WorkMode | null;
  seq: number;
}

interface ComposerState {
  pending: ComposerPrefill | null;
  /** Read the waiting text and clear it (null when there is none). */
  take(): ComposerPrefill | null;
}

let seq = 0;

export const useComposer = create<ComposerState>((set, get) => ({
  pending: null,
  take: () => {
    const p = get().pending;
    if (p) set({ pending: null });
    return p;
  },
}));

/** Put text in the chat composer, ready for the owner to finish and send. */
export function prefill(text: string, opts: { cursor?: number; mode?: WorkMode } = {}): void {
  const cursor = Math.max(0, Math.min(text.length, opts.cursor ?? text.length));
  useComposer.setState({ pending: { text, cursor, mode: opts.mode ?? null, seq: ++seq } });
}

/**
 * What the owner has typed and attached but not sent yet, one draft per task (and one for the
 * new-task composer of each project). The chat screen can close (another tab) and the task can
 * change without losing it, and a draft never moves to another task. The text and work mode are
 * also kept in this browser's storage, so they survive a restart; pictures stay for the session.
 */
export interface ComposerDraft {
  text: string;
  mode: WorkMode;
  refs: DraftReference[];
}

const EMPTY: ComposerDraft = { text: "", mode: "single", refs: [] };
const STORE_KEY = "depo.composer.drafts";

/** The draft's key: the task, or the new-task composer of the project. */
export function draftKey(projectId: string | null, taskId: string | null | undefined): string {
  return taskId ? `task:${taskId}` : `new:${projectId ?? ""}`;
}

function loadSaved(): Record<string, ComposerDraft> {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Record<string, { text?: unknown; mode?: unknown }>;
    const out: Record<string, ComposerDraft> = {};
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v?.text !== "string") continue;
      out[k] = { text: v.text, mode: (typeof v.mode === "string" ? v.mode : "single") as WorkMode, refs: [] };
    }
    return out;
  } catch {
    return {};
  }
}

function save(drafts: Record<string, ComposerDraft>): void {
  try {
    const keep: Record<string, { text: string; mode: WorkMode }> = {};
    for (const [k, d] of Object.entries(drafts))
      if (d.text.trim() || d.mode !== "single") keep[k] = { text: d.text, mode: d.mode };
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(keep));
  } catch {
    // Storage full or blocked: the draft still lives for this session.
  }
}

interface DraftsState {
  drafts: Record<string, ComposerDraft>;
  /** Change part of a draft. */
  update(key: string, patch: Partial<ComposerDraft>): void;
  /** Forget a draft (after it was sent). The caller frees its pictures. */
  clear(key: string): void;
}

export const useDrafts = create<DraftsState>((set, get) => ({
  drafts: loadSaved(),
  update: (key, patch) => {
    const drafts = { ...get().drafts, [key]: { ...(get().drafts[key] ?? EMPTY), ...patch } };
    set({ drafts });
    if ("text" in patch || "mode" in patch) save(drafts);
  },
  clear: (key) => {
    const { [key]: _gone, ...drafts } = get().drafts;
    set({ drafts });
    save(drafts);
  },
}));

/** The draft for a key (an empty one when there is none). */
export function draftOf(drafts: Record<string, ComposerDraft>, key: string): ComposerDraft {
  return drafts[key] ?? EMPTY;
}
