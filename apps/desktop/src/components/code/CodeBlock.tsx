import { Check, Copy } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { languageForFence, languageLabel } from "@/lib/highlight/languages";
import { splitLines } from "@/lib/highlight/tokens";
import { useHighlight } from "@/lib/highlight/use-highlight";
import { copyText } from "@/lib/open-url";
import { Tokens } from "./Tokens";

/**
 * A fenced code block in chat: language label, Copy, and syntax colours from the fence's language
 * ("```ts"). Scrolls inside itself; focusable so keyboard users can scroll it.
 */
export function CodeBlock({ code, info }: { code: string; info: string }) {
  const lang = languageForFence(info);
  const label = languageLabel(lang, info);
  const hl = useHighlight(code, lang);
  const lines = useMemo(() => splitLines(code), [code]);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const t = window.setTimeout(() => setCopied("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-bg">
      <div className="flex h-7 items-center gap-2 border-b border-border pr-1 pl-3 text-[11px] text-muted">
        <span className="font-medium">{label}</span>
        {hl.state === "large" && <span>Large block: shown without colours</span>}
        <span className="flex-1" />
        <button
          type="button"
          aria-label={
            copied === "copied" ? "Copied" : copied === "failed" ? "Copy blocked" : `Copy ${label} code`
          }
          onClick={async () => setCopied((await copyText(code)) ? "copied" : "failed")}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {copied === "copied" ? (
            <Check className="size-3 text-success" aria-hidden />
          ) : (
            <Copy className="size-3" aria-hidden />
          )}
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy blocked" : "Copy"}
        </button>
      </div>
      <figure
        tabIndex={0}
        aria-label={`${label} code`}
        className="m-0 max-h-80 overflow-auto focus-visible:-outline-offset-2"
      >
        <pre className="px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre">
          <code>
            {hl.lines
              ? lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed block
                  <Fragment key={i}>
                    {i > 0 && "\n"}
                    {line && <Tokens tokens={hl.lines?.[i]} text={line} />}
                  </Fragment>
                ))
              : code}
          </code>
        </pre>
      </figure>
    </div>
  );
}
