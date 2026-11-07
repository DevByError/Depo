import type { Token } from "@/lib/highlight/tokens";

/**
 * One line of code: coloured spans when highlighted, the plain text otherwise. Text only, never
 * HTML. An empty line keeps its height with a space.
 */
export function Tokens({ tokens, text }: { tokens: Token[] | null | undefined; text: string }) {
  if (!tokens) return <>{text || " "}</>;
  if (tokens.length === 0) return <> </>;
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
