import type { WorkMode } from "@depo/shared";
import { create } from "zustand";

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
