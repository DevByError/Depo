import type { ChangeSet, DiffSide, Hunk, ReviewComment } from "@depo/shared";
import { REVIEW_COMMENT_MAX_CHARS } from "@depo/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Pencil,
  RotateCcw,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { inputClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useUi } from "@/store/ui";

/**
 * Pull-request style review in Diff Review: line comments under the diff, and a summary bar that
 * sends every open comment back to the task ("Request changes").
 */

export const commentsKey = (changeSetId: string) => ["changes", "comments", changeSetId] as const;

/** A diff row with its line numbers; removed rows are found by their old line, the rest by their new one. */
export interface Row {
  t: string;
  text: string;
  o: number | null;
  n: number | null;
}

export function hunkRows(h: Hunk): Row[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines
    .filter((l) => !l.startsWith("\\"))
    .map((l) => {
      const t = l[0] ?? " ";
      const row = {
        t,
        text: l.slice(1).replace(/\r$/, ""),
        o: t === "+" ? null : o,
        n: t === "-" ? null : n,
      };
      if (t !== "+") o++;
      if (t !== "-") n++;
      return row;
    });
}

export function rowKey(r: Row): { side: DiffSide; line: number } {
  return r.t === "-" ? { side: "old", line: r.o ?? 0 } : { side: "new", line: r.n ?? 0 };
}

export const keyText = (side: DiffSide, line: number) => `${side}:${line}`;

/** "line 12", "removed line 7", "lines 12 to 14". */
export function rowsLabel(first: Row, last: Row): string {
  const a = rowKey(first);
  const b = rowKey(last);
  const one = (k: { side: DiffSide; line: number }) =>
    k.side === "old" ? `removed line ${k.line}` : `line ${k.line}`;
  if (a.side === b.side && a.line === b.line) return one(a);
  if (a.side === b.side) return `${a.side === "old" ? "removed lines" : "lines"} ${a.line} to ${b.line}`;
  return `${one(a)} to ${one(b)}`;
}

/** "app/main.py:12" or "app/main.py:12-14" (new lines when there are any). */
export function commentPlace(c: ReviewComment): string {
  const news = [c.side === "new" ? c.line : null, c.endSide === "new" ? c.endLine : null].filter(
    (x): x is number => x !== null,
  );
  const nums = news.length ? news : [c.line, c.endLine];
  const a = Math.min(...nums);
  const b = Math.max(...nums);
  return `${c.path}:${a === b ? a : `${a}-${b}`}${news.length ? "" : " (removed)"}`;
}

export function commentState(c: ReviewComment): { text: string; tone: string } {
  if (c.status === "outdated") return { text: "Outdated: the lines changed", tone: "text-subtle" };
  if (c.status === "addressed") {
    if (c.addressedBy === "agent") return { text: "The agent says it is done", tone: "text-success" };
    if (c.addressedBy === "owner") return { text: "Marked as done", tone: "text-success" };
    return { text: "Done: the lines changed", tone: "text-success" };
  }
  return c.sentAt
    ? { text: "Sent to the agent", tone: "text-info" }
    : { text: "Not sent yet", tone: "text-muted" };
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A small textarea for a comment: Ctrl+Enter saves, Escape cancels. Grows with the text. */
export function CommentEditor({
  label,
  initial = "",
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  submitLabel: string;
  busy: boolean;
  error?: string | null;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 56), 220)}px`;
  }, [text]);
  const body = text.trim();
  const submit = () => {
    if (body && !busy) onSubmit(body);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-panel p-2 font-sans">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        // biome-ignore lint/a11y/noAutofocus: the owner just chose to write here
        autoFocus
        value={text}
        maxLength={REVIEW_COMMENT_MAX_CHARS}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="What should change here?"
        className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-[12.5px] leading-5 text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-subtle">
          <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> to save, <Kbd>Esc</Kbd> to cancel
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!body || busy} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** One comment under its line: who, when, what happened to it, and edit, delete, done or reopen. */
export function CommentCard({
  c,
  changeSetId,
  editable,
  showPlace = false,
}: {
  c: ReviewComment;
  changeSetId: string;
  editable: boolean;
  showPlace?: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: commentsKey(changeSetId) });
  const update = useMutation({
    mutationFn: (p: { body?: string; status?: "open" | "addressed" }) =>
      call("review.comments.update", { id: c.id, ...p }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => call("review.comments.remove", { id: c.id }),
    onSuccess: () => void refresh(),
  });
  const state = commentState(c);
  return (
    <article
      aria-label={`Comment on ${commentPlace(c)}`}
      className="rounded-md border border-border bg-panel px-3 py-2 font-sans text-[12.5px]"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        <span className="font-medium text-fg">You</span>
        <span className="text-subtle">{time(c.createdAt)}</span>
        {showPlace && <code className="font-mono text-muted">{commentPlace(c)}</code>}
        <span className={cn("ml-auto", state.tone)}>{state.text}</span>
      </header>
      {editing ? (
        <div className="mt-1.5">
          <CommentEditor
            label={`Edit comment on ${commentPlace(c)}`}
            initial={c.body}
            submitLabel="Save"
            busy={update.isPending}
            error={update.isError ? (update.error as Error).message : null}
            onSubmit={(body) => update.mutate({ body })}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <p className="mt-1 leading-relaxed whitespace-pre-wrap break-words text-fg">{c.body}</p>
      )}
      {!editing && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {editable && c.status === "open" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              aria-label={`Edit comment on ${commentPlace(c)}`}
            >
              <Pencil aria-hidden /> Edit
            </Button>
          )}
          {editable && c.status === "open" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: "addressed" })}
            >
              Mark as done
            </Button>
          )}
          {editable && c.status === "addressed" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: "open" })}
            >
              <RotateCcw aria-hidden /> Reopen
            </Button>
          )}
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              aria-label={`Delete comment on ${commentPlace(c)}`}
            >
              <Trash2 aria-hidden /> Delete
            </Button>
          )}
          {(remove.isError || update.isError) && (
            <span role="alert" className="text-[11px] text-danger">
              {((remove.error ?? update.error) as Error).message}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The review summary: how many comments, the ones a newer version addressed, and "Request changes",
 * which sends every open comment to the task in one message (with an optional note).
 */
export function ReviewBar({
  cs,
  comments,
  canRequest,
}: {
  cs: ChangeSet;
  comments: ReviewComment[];
  /** The change set waits for review and belongs to a task. */
  canRequest: boolean;
}) {
  const qc = useQueryClient();
  const setChangeSetId = useUi((s) => s.setChangeSetId);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [showDone, setShowDone] = useState(false);
  const noteId = useId();
  const listId = useId();
  const open = comments.filter((c) => c.status === "open" && c.changeSetId === cs.id);
  const done = comments.filter((c) => c.status !== "open");
  const request = useMutation({
    mutationFn: () => {
      const why = note.trim();
      return call("review.requestChanges", { changeSetId: cs.id, ...(why ? { note: why } : {}) });
    },
    onSuccess: () => {
      setAsking(false);
      setNote("");
      // Show the next version as soon as the agent hands it over.
      setChangeSetId(null);
      void qc.invalidateQueries({ queryKey: commentsKey(cs.id) });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const n = open.length;
  const sentText = request.data
    ? request.data.sent > 0
      ? `Sent ${request.data.sent} comment${request.data.sent === 1 ? "" : "s"} to the agent. It is revising the changes in its private copy.`
      : "Sent your note to the agent. It is revising the changes in its private copy."
    : null;

  return (
    <div className="border-b border-border bg-raised/40" data-testid="review-bar">
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 text-xs">
        <MessageSquare className="size-3.5 text-subtle" aria-hidden />
        <span className="text-fg">
          {n === 0 ? "No open comments" : `${n} open comment${n === 1 ? "" : "s"}`}
        </span>
        {done.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            aria-controls={listId}
            className="inline-flex items-center gap-0.5 rounded px-1 text-muted hover:bg-hover hover:text-fg"
          >
            {showDone ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
            {done.length} done or outdated
          </button>
        )}
        {canRequest && n === 0 && !asking && (
          <span className="text-subtle">Click a line number to comment on it.</span>
        )}
        <span className="flex-1" />
        {canRequest && !asking && (
          <Button size="sm" onClick={() => setAsking(true)} disabled={request.isPending}>
            <SendHorizontal aria-hidden /> Request changes
          </Button>
        )}
      </div>
      {canRequest && asking && (
        <form
          aria-label="Request changes"
          className="flex flex-wrap items-center gap-2 px-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (n > 0 || note.trim()) request.mutate();
          }}
        >
          <label htmlFor={noteId} className="basis-full text-xs text-muted">
            {n > 0
              ? `Send ${n} comment${n === 1 ? "" : "s"} to the agent? It revises its private copy and a new version replaces this one. Add a note if you like.`
              : "Tell the agent what to change. It revises its private copy and a new version replaces this one."}
          </label>
          <input
            id={noteId}
            // biome-ignore lint/a11y/noAutofocus: the owner just opened this form
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setAsking(false);
              }
            }}
            maxLength={REVIEW_COMMENT_MAX_CHARS}
            placeholder={n > 0 ? "Anything else? (optional)" : "e.g. Use the existing date helpers"}
            className={cn(inputClass, "h-7 w-auto min-w-48 flex-1")}
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={request.isPending || (n === 0 && !note.trim())}
          >
            Send to the agent
          </Button>
        </form>
      )}
      {sentText && (
        <p role="status" className="px-4 pb-1.5 text-xs text-muted">
          {sentText}
        </p>
      )}
      {request.isError && (
        <p role="alert" className="px-4 pb-1.5 text-xs text-danger">
          {(request.error as Error).message}
        </p>
      )}
      {showDone && done.length > 0 && (
        <ul id={listId} aria-label="Done and outdated comments" className="flex flex-col gap-1.5 px-4 pb-2">
          {done.map((c) => (
            <li key={c.id}>
              <CommentCard c={c} changeSetId={cs.id} editable showPlace />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
