import type { ChangeSet, Checkpoint, FileChange, Hunk, ReviewComment } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  History,
  MessageSquare,
  MessageSquarePlus,
  MonitorPlay,
  RotateCcw,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Tokens } from "@/components/code/Tokens";
import { CommitChangesBar } from "@/components/git/CommitOffer";
import {
  CommentCard,
  CommentEditor,
  commentsKey,
  hunkRows,
  keyText,
  ReviewBar,
  type Row,
  rowKey,
  rowsLabel,
} from "@/components/review/ReviewComments";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { type LanguageId, languageForPath } from "@/lib/highlight/languages";
import { useDiffHighlight } from "@/lib/highlight/use-highlight";
import { useEngine } from "@/store/engine";
import { usePreviewUi } from "@/store/preview";
import { useUi } from "@/store/ui";

/** For each file: null = whole file, otherwise the selected hunk indexes. */
type Selection = Map<string, Set<number> | null>;

const KIND_ICON = { added: FilePlus, modified: FileText, deleted: FileMinus } as const;
const KIND_LABEL = { added: "New", modified: "Changed", deleted: "Deleted" } as const;
const STATUS_LABEL: Record<ChangeSet["status"], string> = {
  pending: "Waiting for review",
  applied: "Applied",
  partially_applied: "Partly applied",
  discarded: "Discarded",
  superseded: "Replaced by a newer version",
  reverted: "Undone",
};

function defaultSelection(cs: ChangeSet | undefined): Selection {
  const sel: Selection = new Map();
  for (const f of cs?.files ?? []) if (f.status === "pending" && !f.conflict) sel.set(f.path, null);
  return sel;
}

export function DiffReviewPanel() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const changeSetId = useUi((s) => s.changeSetId);
  const setChangeSetId = useUi((s) => s.setChangeSetId);
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => call("changes.list", { projectId: projectId ?? "" }),
    enabled: enabled && !!projectId,
  });
  const sets = list.data?.changeSets ?? [];
  const current =
    sets.find((c) => c.id === changeSetId) ?? sets.find((c) => c.status === "pending") ?? sets[0];

  const [selection, setSelection] = useState<Selection>(() => defaultSelection(current));
  const [openFile, setOpenFile] = useState<string | null>(null);
  // Discard asks first, with an optional reason that Depo remembers as a preference.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [reason, setReason] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  // Reset the selection when another change set is shown (or the same one changes status).
  const key = `${current?.id}:${current?.updatedAt}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the shown change set changes
  useEffect(() => {
    setSelection(defaultSelection(current));
    setOpenFile(current?.files[0]?.path ?? null);
    setConfirmDiscard(false);
    setReason("");
  }, [key]);

  const apply = useMutation({
    mutationFn: () => {
      if (!current) throw new Error("Nothing to apply");
      const files = [...selection.entries()].map(([path, hunks]) =>
        hunks === null ? { path } : { path, hunks: [...hunks] },
      );
      return call("changes.apply", { id: current.id, files });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["changes"] });
      void qc.invalidateQueries({ queryKey: ["checkpoints"] });
    },
  });
  const discard = useMutation({
    mutationFn: () => {
      const why = reason.trim();
      return call("changes.discard", { id: current?.id ?? "", ...(why ? { reason: why } : {}) });
    },
    onSuccess: () => {
      setConfirmDiscard(false);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["changes"] });
      void qc.invalidateQueries({ queryKey: ["memory"] });
    },
  });
  // Line comments of the shown change set (kept by the engine, so they survive a reload).
  const comments = useQuery({
    queryKey: commentsKey(current?.id ?? ""),
    queryFn: () => call("review.comments.list", { changeSetId: current?.id ?? "" }),
    enabled: enabled && !!current,
  });

  if (!projectId) {
    return (
      <Empty title="No project open">
        Open a project folder from the sidebar. Changes made by agents appear here for review.
      </Empty>
    );
  }

  const file = current?.files.find((f) => f.path === openFile) ?? null;
  const reviewable = current && (current.status === "pending" || current.status === "partially_applied");
  const selectedCount = selection.size;
  const allComments = comments.data?.comments ?? [];
  // Comments shown on this version's lines (ones a newer version addressed are listed in the bar).
  const here = allComments.filter((c) => c.changeSetId === current?.id);
  const canComment = !!reviewable && !!current?.taskId;

  return (
    <div className="@container flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {current ? (
              <>
                <label className="sr-only" htmlFor="change-set-select">
                  Change set
                </label>
                <select
                  id="change-set-select"
                  value={current.id}
                  onChange={(e) => setChangeSetId(e.target.value)}
                  className="max-w-full truncate rounded-md border border-transparent bg-transparent py-0.5 text-[13px] font-semibold text-fg outline-none hover:border-border focus:border-accent"
                >
                  {sets.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} · {STATUS_LABEL[c.status]}
                    </option>
                  ))}
                </select>
                <div className="text-[11px] text-muted">
                  {STATUS_LABEL[current.status]} · {current.files.length} file
                  {current.files.length === 1 ? "" : "s"} ·{" "}
                  <span className="text-success">+{sum(current.files, "additions")}</span>{" "}
                  <span className="text-danger">−{sum(current.files, "deletions")}</span>
                </div>
              </>
            ) : (
              <h2 className="text-[13px] font-semibold text-fg">Diff Review</h2>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="@4xl:hidden"
            aria-expanded={showHistory}
            aria-controls="undo-history"
            title="Every apply saves a checkpoint you can undo"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History /> Undo history
          </Button>
          {reviewable && current.taskId && (
            <Button
              size="sm"
              variant="secondary"
              title="Run the app from this task's private copy and open it in the Preview tab"
              onClick={() => {
                usePreviewUi
                  .getState()
                  .show({ projectId, taskId: current.taskId, previewId: null, autoStart: true });
                useUi.getState().setCenterTab("preview");
              }}
            >
              <MonitorPlay /> Preview these changes
            </Button>
          )}
          {reviewable && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDiscard(true)}
                disabled={discard.isPending || confirmDiscard}
              >
                <X /> Discard
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => apply.mutate()}
                disabled={apply.isPending || selectedCount === 0}
              >
                <Check /> Apply {selectedCount} file{selectedCount === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </header>
        {reviewable && confirmDiscard && (
          <form
            aria-label="Discard changes"
            className="flex flex-wrap items-center gap-2 border-b border-border bg-raised/40 px-4 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              discard.mutate();
            }}
          >
            <label htmlFor="discard-reason" className="text-xs text-muted">
              Discard these changes? Tell Depo why (optional) and it will remember.
            </label>
            <input
              id="discard-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Keep the old layout"
              maxLength={500}
              className={cn(inputClass, "h-7 w-auto min-w-48 flex-1")}
            />
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep
            </Button>
            <Button type="submit" size="sm" disabled={discard.isPending}>
              Discard changes
            </Button>
          </form>
        )}
        {current?.taskId && (canComment || allComments.length > 0) && (
          <ReviewBar cs={current} comments={allComments} canRequest={canComment} />
        )}
        {apply.data && (
          <ApplyNotice
            key={apply.data.checkpointId ?? "none"}
            result={apply.data}
            onConflict={() => setShowHistory(true)}
          />
        )}
        {current && <CommitChangesBar projectId={projectId} changeSet={current} />}
        {(apply.isError || discard.isError) && (
          <p role="alert" className="border-b border-border px-4 py-1.5 text-xs text-danger">
            {String((apply.error ?? discard.error) as Error)}
          </p>
        )}

        {!current ? (
          <Empty title="Nothing to review yet">
            When an agent finishes a task, its changes appear here before anything touches your files.
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1">
            <ul
              className="w-48 shrink-0 overflow-y-auto border-r border-border py-1 @3xl:w-64"
              aria-label="Changed files"
            >
              {current.files.map((f) => (
                <FileRow
                  key={f.path}
                  f={f}
                  active={f.path === openFile}
                  reviewable={!!reviewable && f.status === "pending"}
                  checked={selection.has(f.path)}
                  partial={
                    (selection.get(f.path)?.size ?? -1) >= 0 && selection.get(f.path)?.size !== f.hunks.length
                  }
                  comments={here.filter((c) => c.path === f.path && c.status === "open").length}
                  onOpen={() => setOpenFile(f.path)}
                  onToggle={(on) => {
                    const next = new Map(selection);
                    if (on) next.set(f.path, null);
                    else next.delete(f.path);
                    setSelection(next);
                  }}
                />
              ))}
            </ul>
            <section
              className="min-w-0 flex-1 overflow-auto"
              tabIndex={0}
              aria-label={file ? `Diff of ${file.path}` : "Diff"}
            >
              {file && current && (
                <FileDiffView
                  key={`${current.id}:${file.path}`}
                  f={file}
                  changeSetId={current.id}
                  comments={here.filter((c) => c.path === file.path)}
                  canComment={canComment && !file.binary}
                  selectable={!!reviewable && file.status === "pending" && !file.binary}
                  selected={selection.has(file.path) ? (selection.get(file.path) ?? null) : new Set()}
                  onChange={(hunks) => {
                    const next = new Map(selection);
                    if (hunks !== null && hunks.size === 0) next.delete(file.path);
                    else
                      next.set(file.path, hunks !== null && hunks.size === file.hunks.length ? null : hunks);
                    setSelection(next);
                  }}
                />
              )}
            </section>
          </div>
        )}
      </div>
      <HistoryColumn projectId={projectId} open={showHistory} />
    </div>
  );
}

function sum(files: FileChange[], k: "additions" | "deletions"): number {
  return files.reduce((n, f) => n + f[k], 0);
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl border border-border bg-raised text-muted">
          <FileDiff className="size-5" aria-hidden />
        </div>
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

function FileRow({
  f,
  active,
  reviewable,
  checked,
  partial,
  comments,
  onOpen,
  onToggle,
}: {
  f: FileChange;
  active: boolean;
  reviewable: boolean;
  checked: boolean;
  partial: boolean;
  /** Open review comments on this file. */
  comments: number;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
}) {
  const Icon = KIND_ICON[f.kind];
  const name = f.path.split("/").pop() ?? f.path;
  const dir = f.path.slice(0, f.path.length - name.length);
  return (
    <li className={cn("flex items-center gap-2 px-2 py-1", active ? "bg-accent-soft" : "hover:bg-hover")}>
      {reviewable ? (
        <input
          type="checkbox"
          aria-label={`Include ${f.path}`}
          checked={checked}
          ref={(el) => {
            if (el) el.indeterminate = checked && partial;
          }}
          onChange={(e) => onToggle(e.target.checked)}
        />
      ) : (
        <span className="w-[13px]" aria-hidden>
          {f.status === "applied" || f.status === "partially_applied" ? (
            <Check className="size-3 text-success" />
          ) : null}
        </span>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={f.path}
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            f.kind === "added" ? "text-success" : f.kind === "deleted" ? "text-danger" : "text-info",
          )}
          aria-label={KIND_LABEL[f.kind]}
        />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="text-fg">{name}</span>
          {dir && <span className="ml-1 text-[11px] text-subtle">{dir.replace(/\/$/, "")}</span>}
        </span>
        {f.conflict && (
          <AlertTriangle
            className="size-3.5 shrink-0 text-warning"
            aria-label="Changed in your project since"
          />
        )}
        {comments > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-accent tabular-nums">
            <MessageSquare className="size-3" aria-hidden />
            {comments}
            <span className="sr-only"> open comment{comments === 1 ? "" : "s"}</span>
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums">
          <span className="text-success">+{f.additions}</span>{" "}
          <span className="text-danger">−{f.deletions}</span>
        </span>
      </button>
    </li>
  );
}

/** The rows a comment is being written for: one change (hunk), from anchor to focus, either order. */
interface LineSelection {
  hunk: number;
  anchor: number;
  focus: number;
}

function FileDiffView({
  f,
  changeSetId,
  comments,
  canComment,
  selectable,
  selected,
  onChange,
}: {
  f: FileChange;
  changeSetId: string;
  /** Comments shown on this file's lines. */
  comments: ReviewComment[];
  /** Lines can get new comments (the change set waits for review and has a task). */
  canComment: boolean;
  selectable: boolean;
  /** null = all hunks */
  selected: Set<number> | null;
  onChange: (hunks: Set<number> | null) => void;
}) {
  const qc = useQueryClient();
  const isOn = (i: number) => selected === null || selected.has(i);
  const rowsByHunk = useMemo(() => f.hunks.map(hunkRows), [f.hunks]);
  const lang = useMemo(() => languageForPath(f.path), [f.path]);
  const [sel, setSel] = useState<LineSelection | null>(null);
  const [composing, setComposing] = useState(false);
  // The row that takes Tab in each change; arrow keys move it (one tab stop per change).
  const [cursor, setCursor] = useState<{ hunk: number; row: number }>({ hunk: 0, row: 0 });
  const boxRef = useRef<HTMLDivElement>(null);

  // Each comment sits under the row it ends on; one whose row is not in this diff is listed on top.
  const placed = useMemo(() => {
    const keys = new Set(
      rowsByHunk.flatMap((rows) =>
        rows.map((r) => {
          const k = rowKey(r);
          return keyText(k.side, k.line);
        }),
      ),
    );
    const at = new Map<string, ReviewComment[]>();
    const loose: ReviewComment[] = [];
    for (const c of comments) {
      const k = keyText(c.endSide, c.endLine);
      if (keys.has(k)) at.set(k, [...(at.get(k) ?? []), c]);
      else loose.push(c);
    }
    return { at, loose };
  }, [comments, rowsByHunk]);

  const range = sel ? { a: Math.min(sel.anchor, sel.focus), b: Math.max(sel.anchor, sel.focus) } : null;
  const add = useMutation({
    mutationFn: (body: string) => {
      const rows = sel ? rowsByHunk[sel.hunk] : undefined;
      const first = range && rows?.[range.a];
      const last = range && rows?.[range.b];
      if (!first || !last || !range) throw new Error("Choose a line first.");
      return call("review.comments.add", {
        changeSetId,
        path: f.path,
        start: rowKey(first),
        ...(range.b !== range.a ? { end: rowKey(last) } : {}),
        body,
      });
    },
    onSuccess: () => {
      setComposing(false);
      setSel(null);
      void qc.invalidateQueries({ queryKey: commentsKey(changeSetId) });
    },
  });

  const focusRow = (hunk: number, row: number) =>
    boxRef.current?.querySelector<HTMLButtonElement>(`[data-row="${hunk}:${row}"]`)?.focus();

  /** Click (or Enter) on a line; Shift extends the selection to a range in the same change. */
  const pick = (hunk: number, row: number, extend: boolean) => {
    setCursor({ hunk, row });
    add.reset();
    if (extend && sel && sel.hunk === hunk) {
      setSel({ ...sel, focus: row });
      setComposing(true);
    } else if (sel && sel.hunk === hunk && sel.focus === row && sel.anchor !== sel.focus && !composing) {
      // Enter after Shift+arrows: comment on the range chosen with the keyboard.
      setComposing(true);
    } else {
      setSel({ hunk, anchor: row, focus: row });
      setComposing(true);
    }
  };
  /** Arrow keys move between lines; with Shift they grow the selection. */
  const move = (hunk: number, row: number, by: number, extend: boolean) => {
    const rows = rowsByHunk[hunk] ?? [];
    const next = Math.max(0, Math.min(rows.length - 1, row + by));
    setCursor({ hunk, row: next });
    if (extend) {
      setSel((s) => (s && s.hunk === hunk ? { ...s, focus: next } : { hunk, anchor: row, focus: next }));
      setComposing(false);
    }
    focusRow(hunk, next);
  };
  const cancel = () => {
    const at = sel ? { hunk: sel.hunk, row: Math.max(sel.anchor, sel.focus) } : cursor;
    setComposing(false);
    setSel(null);
    add.reset();
    requestAnimationFrame(() => focusRow(at.hunk, at.row));
  };

  return (
    <div className="p-3" ref={boxRef}>
      <div className="mb-2 flex items-center gap-2">
        <code className="font-mono text-xs text-fg">{f.path}</code>
        <span className="text-[11px] text-subtle">{KIND_LABEL[f.kind]}</span>
      </div>
      {f.conflict && (
        <p className="mb-2 flex items-start gap-1.5 rounded-md border border-border bg-raised/40 px-2.5 py-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This file changed in your project after the agent started. It is not applied automatically; the diff
          shows the agent's version against your current file.
        </p>
      )}
      {placed.loose.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          {placed.loose.map((c) => (
            <CommentCard key={c.id} c={c} changeSetId={changeSetId} editable={canComment} showPlace />
          ))}
        </div>
      )}
      {f.binary ? (
        <p className="text-xs text-muted">
          Binary file {f.kind === "deleted" ? "deleted" : "changed"}. No text preview.
        </p>
      ) : f.hunks.length === 0 ? (
        <p className="text-xs text-muted">Empty file.</p>
      ) : (
        f.hunks.map((h, i) => (
          <HunkView
            key={`${h.oldStart}-${h.newStart}`}
            h={h}
            rows={rowsByHunk[i] ?? []}
            lang={lang}
            index={i}
            selectable={selectable}
            on={isOn(i)}
            onToggle={(on) => {
              const all = new Set(f.hunks.map((_, k) => k));
              const cur = selected === null ? all : new Set(selected);
              if (on) cur.add(i);
              else cur.delete(i);
              onChange(cur.size === f.hunks.length ? null : cur);
            }}
            canComment={canComment}
            changeSetId={changeSetId}
            commentsAt={placed.at}
            range={sel?.hunk === i ? range : null}
            composing={composing && sel?.hunk === i}
            tabRow={cursor.hunk === i ? cursor.row : 0}
            onPick={(row, extend) => pick(i, row, extend)}
            onMove={(row, by, extend) => move(i, row, by, extend)}
            onClear={cancel}
            editor={
              range && sel?.hunk === i ? (
                <CommentEditor
                  label={`Comment on ${rowsLabel(
                    (rowsByHunk[i] ?? [])[range.a] as Row,
                    (rowsByHunk[i] ?? [])[range.b] as Row,
                  )}`}
                  submitLabel="Add comment"
                  busy={add.isPending}
                  error={add.isError ? (add.error as Error).message : null}
                  onSubmit={(body) => add.mutate(body)}
                  onCancel={cancel}
                />
              ) : null
            }
          />
        ))
      )}
    </div>
  );
}

function HunkView({
  h,
  rows,
  lang,
  index,
  selectable,
  on,
  onToggle,
  canComment,
  changeSetId,
  commentsAt,
  range,
  composing,
  tabRow,
  onPick,
  onMove,
  onClear,
  editor,
}: {
  h: Hunk;
  rows: Row[];
  /** For syntax colours; null shows plain text. */
  lang: LanguageId | null;
  index: number;
  selectable: boolean;
  on: boolean;
  onToggle: (on: boolean) => void;
  canComment: boolean;
  changeSetId: string;
  commentsAt: Map<string, ReviewComment[]>;
  /** Selected rows of this change (row indexes), if any. */
  range: { a: number; b: number } | null;
  composing: boolean;
  tabRow: number;
  onPick: (row: number, extend: boolean) => void;
  onMove: (row: number, by: number, extend: boolean) => void;
  onClear: () => void;
  editor: ReactNode;
}) {
  const hl = useDiffHighlight(rows, lang);
  return (
    <div
      className={cn(
        "mb-3 overflow-hidden rounded-lg border border-border",
        selectable && !on && "opacity-55",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-raised/60 px-2 py-1 font-mono text-[11px] text-subtle">
        {selectable && (
          <input
            type="checkbox"
            aria-label={`Include change ${index + 1}`}
            checked={on}
            onChange={(e) => onToggle(e.target.checked)}
          />
        )}
        @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
        {hl.large && <span className="font-sans text-muted">Large change: shown without colours</span>}
      </div>
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
        <tbody>
          {rows.map((r, k) => {
            const key = rowKey(r);
            const here = commentsAt.get(keyText(key.side, key.line)) ?? [];
            const picked = range !== null && k >= range.a && k <= range.b;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no stable identity
              <Fragment key={k}>
                <tr
                  className={cn(
                    r.t === "+" ? "bg-success/12" : r.t === "-" ? "bg-danger/12" : undefined,
                    picked && "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]",
                  )}
                >
                  <td className="w-20 p-0 align-top">
                    {canComment ? (
                      <button
                        type="button"
                        data-row={`${index}:${k}`}
                        tabIndex={k === tabRow ? 0 : -1}
                        aria-label={`Comment on ${rowsLabel(r, r)}`}
                        onClick={(e) => onPick(k, e.shiftKey)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            onMove(k, e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
                          } else if (e.key === "Escape" && range) {
                            e.preventDefault();
                            onClear();
                          }
                        }}
                        className="group relative flex w-full select-none items-start text-[11px] text-subtle hover:text-fg"
                      >
                        <MessageSquarePlus
                          className="absolute top-[3px] left-0.5 size-3 text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                          aria-hidden
                        />
                        <span className="w-10 px-1.5 text-right">{r.o ?? ""}</span>
                        <span className="w-10 px-1.5 text-right">{r.n ?? ""}</span>
                      </button>
                    ) : (
                      <div className="flex select-none text-[11px] text-subtle">
                        <span className="w-10 px-1.5 text-right">{r.o ?? ""}</span>
                        <span className="w-10 px-1.5 text-right">{r.n ?? ""}</span>
                      </div>
                    )}
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
                    <span className="sr-only">
                      {r.t === "+" ? "added: " : r.t === "-" ? "removed: " : ""}
                    </span>
                    <Tokens tokens={hl.tokens[k]} text={r.text} />
                  </td>
                </tr>
                {here.length > 0 && (
                  <tr>
                    <td colSpan={3} className="border-y border-border bg-bg px-3 py-2">
                      <div className="flex flex-col gap-1.5">
                        {here.map((c) => (
                          <CommentCard key={c.id} c={c} changeSetId={changeSetId} editable={canComment} />
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
                {composing && range && k === range.b && (
                  <tr>
                    <td colSpan={3} className="border-y border-border bg-bg px-3 py-2">
                      {editor}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "Applied 2 files" with an Undo right there; Undo history keeps every older checkpoint. */
function ApplyNotice({
  result,
  onConflict,
}: {
  result: { applied: string[]; conflicts: string[]; checkpointId: string | null };
  onConflict(): void;
}) {
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: (id: string) => call("checkpoints.restore", { id, force: false }),
    onSuccess: (r) => {
      if (r.conflicts.length > 0) onConflict();
      void qc.invalidateQueries({ queryKey: ["checkpoints"] });
      void qc.invalidateQueries({ queryKey: ["changes"] });
    },
  });
  const n = result.applied.length;
  const undone = undo.data && undo.data.conflicts.length === 0;
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-raised/40 px-4 py-1.5 text-xs text-muted"
    >
      {undone ? (
        <span>Undone. Your files are back as they were before this apply.</span>
      ) : undo.data ? (
        <span className="text-warning">
          You edited {undo.data.conflicts.join(", ")} after this apply, so nothing was undone. Undo history
          lets you choose.
        </span>
      ) : (
        <span>
          Applied {n} file{n === 1 ? "" : "s"}. A checkpoint was saved, so you can undo it.
          {result.conflicts.length > 0 && (
            <span className="text-warning"> Skipped (changed since): {result.conflicts.join(", ")}</span>
          )}
        </span>
      )}
      {result.checkpointId && !undo.data && (
        <Button
          size="sm"
          variant="ghost"
          disabled={undo.isPending}
          onClick={() => result.checkpointId && undo.mutate(result.checkpointId)}
        >
          <RotateCcw /> Undo
        </Button>
      )}
      {undo.isError && <span className="text-danger">{String(undo.error)}</span>}
    </p>
  );
}

/** Checkpoints to undo applies. Folds into a header button when the panel is narrow. */
function HistoryColumn({ projectId, open }: { projectId: string; open: boolean }) {
  const enabled = useEngine((s) => s.status === "open");
  const qc = useQueryClient();
  const cps = useQuery({
    queryKey: ["checkpoints", projectId],
    queryFn: () => call("checkpoints.list", { projectId }),
    enabled,
  });
  const [conflict, setConflict] = useState<{ id: string; files: string[] } | null>(null);
  const restore = useMutation({
    mutationFn: (v: { id: string; force: boolean }) => call("checkpoints.restore", v),
    onSuccess: (r, v) => {
      if (r.conflicts.length && !v.force) setConflict({ id: v.id, files: r.conflicts });
      else setConflict(null);
      void qc.invalidateQueries({ queryKey: ["checkpoints"] });
      void qc.invalidateQueries({ queryKey: ["changes"] });
    },
  });
  const list = cps.data?.checkpoints ?? [];
  return (
    <aside
      id="undo-history"
      className={cn("w-60 shrink-0 flex-col border-l border-border", open ? "flex" : "hidden @4xl:flex")}
      aria-label="Undo history"
    >
      <h3 className="flex items-center gap-1.5 border-b border-border px-3 py-2.5 text-xs font-semibold text-fg">
        <History className="size-3.5 text-subtle" aria-hidden /> Undo history
      </h3>
      <section className="min-h-0 flex-1 overflow-y-auto p-2" tabIndex={0} aria-label="Checkpoints">
        {list.length === 0 ? (
          <p className="px-1 text-xs text-muted">Every apply saves a checkpoint here, so you can undo it.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {list.map((c) => (
              <CheckpointRow
                key={c.id}
                c={c}
                busy={restore.isPending}
                onUndo={() => restore.mutate({ id: c.id, force: false })}
              />
            ))}
          </ol>
        )}
        {conflict && (
          <div role="alert" className="mt-2 rounded-md border border-border bg-raised/40 p-2 text-xs">
            <p className="text-warning">
              You edited {conflict.files.join(", ")} after this apply. Undo would overwrite those edits.
            </p>
            <div className="mt-1.5 flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
                Keep my edits
              </Button>
              <Button size="sm" onClick={() => restore.mutate({ id: conflict.id, force: true })}>
                Undo anyway
              </Button>
            </div>
          </div>
        )}
        {restore.isError && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {String(restore.error)}
          </p>
        )}
      </section>
    </aside>
  );
}

function CheckpointRow({ c, busy, onUndo }: { c: Checkpoint; busy: boolean; onUndo: () => void }) {
  return (
    <li className="rounded-md border border-border px-2.5 py-2">
      <div className="text-xs text-fg">{c.label.replace(/^Before applying: /, "")}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-subtle">
        <span>{new Date(c.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span>
          {c.files.length} file{c.files.length === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        {c.status === "active" ? (
          <button
            type="button"
            onClick={onUndo}
            disabled={busy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <RotateCcw className="size-3" aria-hidden /> Undo
          </button>
        ) : (
          <span>Undone</span>
        )}
      </div>
    </li>
  );
}
