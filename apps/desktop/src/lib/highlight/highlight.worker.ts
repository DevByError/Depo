import type { LanguageId } from "./languages";
import { tokenize } from "./tokenize";
import type { Token } from "./tokens";

/** Highlighting off the main thread: requests are answered by id, in order. */
export interface HighlightRequest {
  id: number;
  code: string;
  lang: LanguageId;
}
export type HighlightReply = { id: number; lines: Token[][] } | { id: number; error: string };

// The app compiles against the DOM library; this is the small part of the worker scope used here.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(reply: HighlightReply): void;
};

scope.onmessage = (e) => {
  const { id, code, lang } = e.data;
  tokenize(code, lang).then(
    (lines) => scope.postMessage({ id, lines }),
    (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
