import type { GitFileDiff, Hunk } from "@depo/shared";
import { ChevronRight, FileMinus, FilePlus, FileSymlink, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { Tokens } from "@/components/code/Tokens";
import { hunkRows } from "@/components/review/ReviewComments";
import { cn } from "@/lib/cn";
import { type LanguageId, languageForPath } from "@/lib/highlight/languages";
import { useDiffHighlight } from "@/lib/highlight/use-highlight";

const KIND_ICON = { added: FilePlus, modified: FileText, deleted: FileMinus, renamed: FileSymlink } as const;
const KIND_LABEL = { added: "New", modified: "Changed", deleted: "Deleted", renamed: "Renamed" } as const;
const KIND_TONE = {
  added: "text-success",
  modified: "text-info",
  deleted: "text-danger",
  renamed: "text-info",
} as const;

/** A commit's files and hunks, read-only. The first few files start open. */
export function CommitDiff({ files }: { files: GitFileDiff[] }) {
  if (files.length === 0) return <p className="p-3 text-xs text-muted">This commit changes no files.</p>;
  return (
    <div className="flex flex-col gap-2 p-3">
      {files.map((f, i) => (
        <FileBlock key={`${f.oldPath ?? ""}>${f.path}`} f={f} open={i < 5} />
      ))}
    </div>
  );
}

function FileBlock({ f, open }: { f: GitFileDiff; open: boolean }) {
  const Icon = KIND_ICON[f.kind];
  const lang = useMemo(() => languageForPath(f.path), [f.path]);
  // Closed files are not highlighted until they are opened.
  const [isOpen, setIsOpen] = useState(open);
  return (
    <details
      open={open}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
      className="group overflow-hidden rounded-lg border border-border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 bg-raised/60 px-2.5 py-1.5 text-xs hover:bg-hover">
        <ChevronRight
          className="size-3 shrink-0 text-subtle transition-transform group-open:rotate-90"
          aria-hidden
        />
        <Icon className={cn("size-3.5 shrink-0", KIND_TONE[f.kind])} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-fg" title={f.path}>
          {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        </span>
        <span className="shrink-0 text-[11px] text-subtle">{KIND_LABEL[f.kind]}</span>
        <span className="shrink-0 text-[11px] tabular-nums">
          <span className="text-success">+{f.additions}</span>{" "}
          <span className="text-danger">−{f.deletions}</span>
        </span>
      </summary>
      {f.binary ? (
        <p className="px-3 py-2 text-xs text-muted">Binary file. No text preview.</p>
      ) : f.hunks.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted">No text changes (only the file name or mode changed).</p>
      ) : (
        f.hunks.map((h) => <HunkRows key={`${h.oldStart}-${h.newStart}`} h={h} lang={isOpen ? lang : null} />)
      )}
      {f.truncated && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
          This file's diff is long, so only the start is shown.
        </p>
      )}
    </details>
  );
}

function HunkRows({ h, lang }: { h: Hunk; lang: LanguageId | null }) {
  const rows = useMemo(() => hunkRows(h), [h]);
  const hl = useDiffHighlight(rows, lang);
  return (
    <div className="border-t border-border">
      <div className="bg-raised/40 px-2 py-0.5 font-mono text-[11px] text-subtle">
        @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
        {hl.large && <span className="ml-2 font-sans text-muted">Large change: shown without colours</span>}
      </div>
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
        <tbody>
          {rows.map((r, k) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no stable identity
              key={k}
              className={r.t === "+" ? "bg-success/12" : r.t === "-" ? "bg-danger/12" : undefined}
            >
              <td className="w-10 select-none px-1.5 text-right align-top text-[11px] text-subtle">
                {r.o ?? ""}
              </td>
              <td className="w-10 select-none px-1.5 text-right align-top text-[11px] text-subtle">
                {r.n ?? ""}
              </td>
              <td
                className={cn(
                  "w-4 select-none text-center align-top",
                  r.t === "+" ? "text-success" : r.t === "-" ? "text-danger" : "text-subtle",
                )}
                aria-hidden
              >
                {r.t === " " ? "" : r.t === "-" ? "−" : r.t}
              </td>
              <td className="whitespace-pre-wrap break-all pr-3 align-top text-fg">
                <span className="sr-only">{r.t === "+" ? "added: " : r.t === "-" ? "removed: " : ""}</span>
                <Tokens tokens={hl.tokens[k]} text={r.text} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
