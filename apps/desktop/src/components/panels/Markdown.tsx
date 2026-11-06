import { Fragment, type ReactNode } from "react";

/** Small, safe Markdown renderer (no HTML injection): headings, lists, code blocks, bold, italic, inline code, links as text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`"))
      out.push(
        <code key={k++} className="rounded bg-hover px-1 py-0.5 font-mono text-[12px]">
          {t.slice(1, -1)}
        </code>,
      );
    else if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) buf.push(lines[i++] ?? "");
      i++;
      blocks.push(
        <pre
          key={key++}
          className="my-2 max-h-80 overflow-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] whitespace-pre"
        >
          {buf.join("\n")}
        </pre>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(
        <p key={key++} className="mt-2 font-semibold">
          {inline(line.replace(/^#{1,4}\s+/, ""))}
        </p>,
      );
      i++;
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i++] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""));
      }
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={key++} className={`my-1.5 ml-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static list
            <li key={n}>{inline(it)}</li>
          ))}
        </L>,
      );
    } else if (line.trim() === "") {
      i++;
    } else {
      const buf: string[] = [];
      while (
        i < lines.length &&
        (lines[i] ?? "").trim() !== "" &&
        !(lines[i] ?? "").startsWith("```") &&
        !/^#{1,4}\s/.test(lines[i] ?? "") &&
        !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")
      )
        buf.push(lines[i++] ?? "");
      blocks.push(
        <p key={key++} className="my-1.5">
          {buf.map((b, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines
            <Fragment key={n}>
              {n > 0 && <br />}
              {inline(b)}
            </Fragment>
          ))}
        </p>,
      );
    }
  }
  return <>{blocks}</>;
}
