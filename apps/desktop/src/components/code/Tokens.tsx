import type { Token } from "@/lib/highlight/tokens";

function sameText(tokens: Token[], text: string): boolean {
  let at = 0;
  for (const t of tokens) {
    if (!text.startsWith(t.text, at)) return false;
    at += t.text.length;
  }
  return at === text.length;
}

/**
 * One line of code: coloured spans when highlighted, the plain text otherwise. Text only, never
 * HTML. Tokens that do not spell exactly `text` (colours from an older version of a streaming
 * block) are ignored, so the line always shows its real text. An empty line keeps its height.
 */
export function Tokens({ tokens, text }: { tokens: Token[] | null | undefined; text: string }) {
  if (!text) return <> </>;
  if (!tokens || !sameText(tokens, text)) return <>{text}</>;
  return (
    <>
      {tokens.map((t, i) =>
        t.kind ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens of a fixed line
          <span key={i} className={`tok-${t.kind}`}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  );
}
