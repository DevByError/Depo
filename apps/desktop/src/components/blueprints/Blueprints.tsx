import type { BlueprintFileInfo, BlueprintSummary } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { Circle, CircleDot, FileText, Folder, Loader2 } from "lucide-react";
import { type KeyboardEvent, useId, useRef } from "react";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";

/** The one-line pitch, shown wherever blueprints are offered. */
export const BLUEPRINT_PITCH = "A tested starting point. Agents build your features on top of it.";

/** The blueprints, loaded once per session (they ship with Depo and do not change). */
export function useBlueprints(enabled: boolean) {
  return useQuery({
    queryKey: ["blueprints"],
    queryFn: () => call("blueprints.list", {}),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function StackChips({ stack, max = 6 }: { stack: string[]; max?: number }) {
  const shown = stack.slice(0, max);
  const more = stack.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="sr-only">Built with </span>
      {shown.map((s, i) => (
        <span
          key={s}
          className="rounded-full border border-border bg-bg px-1.5 py-px text-[10px] leading-4 text-muted"
        >
          {s}
          {i < shown.length - 1 && <span className="sr-only">,</span>}
        </span>
      ))}
      {more > 0 && <span className="text-[10px] text-subtle">and {more} more</span>}
    </span>
  );
}

export function WhatYouGet({ features, className }: { features: string[]; className?: string }) {
  return (
    <div className={className}>
      <div className="text-xs font-medium text-fg">What you get</div>
      <ul className="mt-1 list-disc pl-4 text-[11px] leading-relaxed text-muted">
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </div>
  );
}

type StartOption = Pick<BlueprintSummary, "id" | "title" | "summary" | "stack">;

const EMPTY: StartOption = {
  id: "",
  title: "Empty folder",
  summary: "A README and nothing else. Agents start from a blank page.",
  stack: [],
};

/**
 * "Start from": an empty folder or one of the blueprints, as radio cards. One card is in the tab
 * order; the arrow keys move the choice, like native radio buttons.
 */
export function StartFromPicker({
  value,
  onChange,
  blueprints,
  labelledBy,
}: {
  value: string;
  onChange: (id: string) => void;
  blueprints: StartOption[];
  labelledBy: string;
}) {
  const uid = useId();
  const options = [EMPTY, ...blueprints];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );
  const go = (i: number) => {
    const n = (i + options.length) % options.length;
    const o = options[n];
    if (!o) return;
    onChange(o.id);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? i + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    go(to);
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((o, i) => {
        const on = i === current;
        const about = `${uid}-${o.id || "empty"}`;
        return (
          <div
            key={o.id || "empty"}
            className={cn(
              "relative flex flex-col gap-1 rounded-lg border p-2.5 transition-colors",
              on ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
            )}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a card-sized radio; role, state and arrow keys are set. */}
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-describedby={about}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(o.id)}
              onKeyDown={(e) => onKey(e, i)}
              className="flex items-center gap-1.5 text-left text-[13px] font-medium text-fg outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-accent"
            >
              {on ? (
                <CircleDot className="size-3.5 shrink-0 text-accent" aria-hidden />
              ) : (
                <Circle className="size-3.5 shrink-0 text-subtle" aria-hidden />
              )}
              {o.title}
            </button>
            <span id={about} className="line-clamp-2 text-[11px] leading-snug text-muted">
              {o.summary}
            </span>
            {o.stack.length > 0 && <StackChips stack={o.stack} max={4} />}
          </div>
        );
      })}
    </div>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

interface TreeNode {
  name: string;
  size: number | null;
  children: TreeNode[];
}

/** Paths to a folder tree: folders first, then files, each by name. */
export function fileTree(files: BlueprintFileInfo[]): TreeNode[] {
  const root: TreeNode = { name: "", size: null, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let at = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let next = at.children.find((c) => c.name === part && (c.size === null) === !leaf);
      if (!next) {
        next = { name: part, size: leaf ? f.size : null, children: [] };
        at.children.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => Number(a.size !== null) - Number(b.size !== null) || a.name.localeCompare(b.name))
      .map((n) => ({ ...n, children: sort(n.children) }));
  return sort(root.children);
}

function TreeList({ nodes, nested }: { nodes: TreeNode[]; nested?: boolean }) {
  return (
    <ul className={cn(nested && "ml-3 border-l border-border pl-2")}>
      {nodes.map((n) =>
        n.size === null ? (
          <li key={`d:${n.name}`}>
            <span className="flex items-center gap-1 py-px text-fg">
              <Folder className="size-3 shrink-0 text-subtle" aria-hidden />
              {n.name}/
            </span>
            <TreeList nodes={n.children} nested />
          </li>
        ) : (
          <li key={`f:${n.name}`} className="flex items-center gap-1 py-px">
            <FileText className="size-3 shrink-0 text-subtle" aria-hidden />
            <span className="min-w-0 truncate text-muted">{n.name}</span>
            <span className="ml-auto shrink-0 pl-2 text-subtle">{formatSize(n.size)}</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** The files a blueprint writes, with their sizes, in a scrollable tree. */
export function BlueprintFiles({ id, title }: { id: string; title: string }) {
  const detail = useQuery({
    queryKey: ["blueprint", id],
    queryFn: () => call("blueprints.get", { id }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (detail.isPending)
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading the files…
      </p>
    );
  if (detail.isError)
    return (
      <p role="alert" className="text-xs text-danger">
        {(detail.error as Error).message}
      </p>
    );
  const d = detail.data;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-fg">
        Files{" "}
        <span className="font-normal text-subtle">
          ({d.files.length}, {formatSize(d.totalBytes)})
        </span>
      </div>
      <section
        tabIndex={0}
        aria-label={`Files in the ${title} blueprint`}
        className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <TreeList nodes={fileTree(d.files)} />
      </section>
    </div>
  );
}
