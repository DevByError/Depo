import type { CodeHotSpot, CodeMap } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleDot, FolderOpen, Loader2, Package, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/modal";
import { AGENT_SOFT } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { AREA_LABEL, AREA_TONE, compactNumber, moduleLabel, plural, shortPath } from "@/lib/code-map";
import { call } from "@/lib/engine";
import { openInFiles } from "@/lib/open-file";
import { useEngine } from "@/store/engine";

const LIST_MAX = 50;

/** The files of one module, busiest first, with the files elsewhere they work with. */
export function ModuleFiles({
  projectId,
  module,
  onFile,
  onClose,
}: {
  projectId: string;
  module: string;
  onFile(path: string): void;
  onClose(): void;
}) {
  const enabled = useEngine((s) => s.status === "open");
  const q = useQuery({
    queryKey: ["codemap", projectId, "files", module],
    queryFn: () => call("codemap.get", { projectId, level: "file", module, limit: 300 }),
    enabled,
  });
  const inside = (q.data?.nodes ?? [])
    .filter((n) => !n.outside)
    .sort((a, b) => b.importedBy - a.importedBy || a.id.localeCompare(b.id));
  const outside = (q.data?.nodes ?? []).filter((n) => n.outside).slice(0, 10);
  const area = inside[0]?.area;
  return (
    <section aria-label={`Files in ${moduleLabel(module)}`} className="flex min-w-0 flex-col gap-2">
      <header className="flex items-center gap-2">
        <h3
          className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg"
          title={moduleLabel(module)}
        >
          {moduleLabel(module)}
        </h3>
        {area && (
          <span className={cn("rounded px-1.5 py-0.5 text-[11px]", AGENT_SOFT[AREA_TONE[area]])}>
            {AREA_LABEL[area]}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>
      {q.isError && <ErrorText error={q.error} />}
      {q.isLoading && <Loading />}
      {q.data && (
        <>
          <p className="text-[11px] text-subtle">
            {plural(q.data.summary.files, "file")} · {compactNumber(q.data.summary.lines)} lines
            {q.data.truncated ? " · showing the 300 busiest" : ""}
          </p>
          <ul className="flex flex-col">
            {inside.map((n) => (
              <li key={n.id}>
                <FileRow
                  path={n.id}
                  label={n.label}
                  detail={`${compactNumber(n.lines)} lines${n.importedBy ? ` · imported by ${n.importedBy}` : ""}`}
                  inCycle={n.inCycle}
                  entry={n.entry}
                  onClick={() => onFile(n.id)}
                />
              </li>
            ))}
          </ul>
          {outside.length > 0 && (
            <>
              <h4 className="mt-2 text-[11px] font-medium text-muted">Files elsewhere they work with</h4>
              <ul className="flex flex-col">
                {outside.map((n) => (
                  <li key={n.id}>
                    <FileRow
                      path={n.id}
                      label={n.id}
                      detail={moduleLabel(n.module ?? "")}
                      onClick={() => onFile(n.id)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function FileRow({
  path,
  label,
  detail,
  inCycle = false,
  entry = false,
  onClick,
}: {
  path: string;
  label: string;
  detail: string;
  inCycle?: boolean;
  entry?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={path}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{shortPath(label, 56)}</span>
      {inCycle && (
        <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-danger">
          <RefreshCcw className="size-3" aria-hidden />
          cycle
        </span>
      )}
      {entry && (
        <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted">
          <CircleDot className="size-3" aria-hidden />
          entry
        </span>
      )}
      <span className="shrink-0 text-[11px] text-subtle tabular-nums">{detail}</span>
    </button>
  );
}

/** One file: what it imports, what imports it, its symbols, and a way to open it. */
export function FileDetails({
  projectId,
  path,
  onFile,
  onBack,
  backLabel,
}: {
  projectId: string;
  path: string;
  onFile(path: string): void;
  onBack(): void;
  backLabel: string;
}) {
  const enabled = useEngine((s) => s.status === "open");
  const q = useQuery({
    queryKey: ["codemap", projectId, "file", path],
    queryFn: () => call("codemap.file", { projectId, path }),
    enabled,
  });
  const f = q.data;
  const facts = f
    ? [
        f.lang,
        `${compactNumber(f.lines)} lines`,
        f.branches ? plural(f.branches, "branch") : null,
        f.churn ? `changed in ${plural(f.churn, "commit")}` : null,
      ].filter(Boolean)
    : [];
  return (
    <section aria-label={`File ${path}`} className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden /> {backLabel}
        </Button>
        <h3 className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg" title={path}>
          {path}
        </h3>
        <Button size="sm" onClick={() => openInFiles(path)}>
          <FolderOpen aria-hidden /> Open in Files
        </Button>
      </header>
      {q.isError && <ErrorText error={q.error} />}
      {q.isLoading && <Loading />}
      {f && (
        <>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span className={cn("rounded px-1.5 py-0.5", AGENT_SOFT[AREA_TONE[f.area]])}>
              {AREA_LABEL[f.area]}
            </span>
            <span>{facts.join(" · ")}</span>
            {f.entry && (
              <span className="flex items-center gap-1">
                <CircleDot className="size-3" aria-hidden />
                Entry point: {f.entry}
              </span>
            )}
            {f.inCycle && (
              <span className="flex items-center gap-1 text-danger">
                <RefreshCcw className="size-3" aria-hidden />
                In an import cycle
              </span>
            )}
          </p>
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
            <Group title="Imports" count={f.imports.length} empty="It imports nothing.">
              {f.imports.slice(0, LIST_MAX).map((i) => (
                <li key={`${i.line}:${i.spec}`} className="flex items-center gap-2 text-xs">
                  {i.target ? (
                    <LinkButton onClick={() => onFile(i.target ?? "")} title={i.target}>
                      {shortPath(i.target, 48)}
                    </LinkButton>
                  ) : i.library ? (
                    <span className="flex min-w-0 flex-1 items-center gap-1 px-2 py-0.5 text-muted">
                      <Package className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{i.library}</span>
                    </span>
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate px-2 py-0.5 font-mono text-[11px] text-subtle"
                      title={i.spec}
                    >
                      {i.spec} (not found)
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-subtle tabular-nums">line {i.line}</span>
                </li>
              ))}
              <More count={f.imports.length} />
            </Group>
            <Group title="Imported by" count={f.importedBy.length} empty="No project file imports it.">
              {f.importedBy.slice(0, LIST_MAX).map((i) => (
                <li key={`${i.path}:${i.line}`} className="flex items-center gap-2 text-xs">
                  <LinkButton onClick={() => onFile(i.path)} title={i.path}>
                    {shortPath(i.path, 48)}
                  </LinkButton>
                  <span className="shrink-0 text-[11px] text-subtle tabular-nums">line {i.line}</span>
                </li>
              ))}
              <More count={f.importedBy.length} />
            </Group>
          </div>
          <Group title="Symbols" count={f.symbols.length} empty="No functions or classes found.">
            {f.symbols.slice(0, LIST_MAX).map((s) => (
              <li key={`${s.startLine}:${s.name}`} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                <span className="w-16 shrink-0 text-[11px] text-subtle">{s.kind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg" title={s.signature}>
                  {s.parent ? `${s.parent}.` : ""}
                  {s.name}
                </span>
                <span className="shrink-0 text-[11px] text-subtle tabular-nums">line {s.startLine}</span>
              </li>
            ))}
            <More count={f.symbols.length} />
          </Group>
        </>
      )}
    </section>
  );
}

function Group({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-[11px] font-medium text-muted">
        {title} ({count})
      </h4>
      {count === 0 ? (
        <p className="px-2 text-[11px] text-subtle">{empty}</p>
      ) : (
        <ul className="flex flex-col">{children}</ul>
      )}
    </div>
  );
}

function More({ count }: { count: number }) {
  if (count <= LIST_MAX) return null;
  return <li className="px-2 pt-1 text-[11px] text-subtle">and {count - LIST_MAX} more</li>;
}

function LinkButton({ children, onClick, title }: { children: ReactNode; onClick(): void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="min-w-0 flex-1 truncate rounded px-2 py-0.5 text-left font-mono text-[11px] text-fg hover:bg-hover"
    >
      {children}
    </button>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-xs text-muted">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      Reading the code…
    </p>
  );
}

const HOT_SPOTS: { key: keyof CodeMap["hotSpots"]; title: string }[] = [
  { key: "dependedOn", title: "Most imported" },
  { key: "largest", title: "Largest" },
  { key: "complex", title: "Most complex" },
  { key: "churn", title: "Changed most" },
];

/** Files worth knowing first: the most imported, the largest, the most complex, the most changed. */
export function HotSpots({
  hotSpots,
  max,
  onFile,
}: {
  hotSpots: CodeMap["hotSpots"];
  max: number;
  onFile(path: string): void;
}) {
  const groups = HOT_SPOTS.filter((g) => hotSpots[g.key].length > 0);
  if (groups.length === 0) return null;
  return (
    <section aria-label="Hot spots" className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold text-fg">Hot spots</h3>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 @xl:grid-cols-2">
        {groups.map((g) => (
          <div key={g.key} className="min-w-0">
            <h4 className="mb-1 text-[11px] font-medium text-muted">{g.title}</h4>
            <ol className="flex flex-col">
              {hotSpots[g.key].slice(0, max).map((h: CodeHotSpot) => (
                <li key={h.path}>
                  <button
                    type="button"
                    onClick={() => onFile(h.path)}
                    title={h.path}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-0.5 text-left hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
                      {shortPath(h.path, 40)}
                    </span>
                    <span className="shrink-0 text-[11px] text-subtle">{h.detail}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
