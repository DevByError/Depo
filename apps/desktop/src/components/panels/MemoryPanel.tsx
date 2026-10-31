import type { MemoryFact, MemoryKind } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookMarked, Check, GraduationCap, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, inputClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatRelative } from "@/lib/format";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

type Scope = "project" | "global";

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "Fact",
  decision: "Decision",
  preference: "Preference",
  lesson: "Lesson",
};

/**
 * Project memory (a Markdown note plus facts, decisions and preferences) and global memory
 * (preferences for every project). Agents read both before each task; lessons are learned when
 * an agent fixes a failing test.
 */
export function MemoryPanel() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const [scope, setScope] = useState<Scope>(projectId ? "project" : "global");
  const target = scope === "project" ? projectId : null;
  const memory = useQuery({
    queryKey: ["memory", target],
    queryFn: () => call("memory.get", { projectId: target }),
    enabled: enabled && (scope === "global" || !!projectId),
  });

  const facts = memory.data?.facts ?? [];
  const lessons = facts.filter((f) => f.kind === "lesson");
  const others = facts.filter((f) => f.kind !== "lesson");

  return (
    <section aria-label="Memory" className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
        <header className="flex items-center gap-3">
          <BookMarked className="size-5 text-muted" aria-hidden />
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-fg">Memory</h1>
            <p className="text-xs text-muted">
              What agents know before they start. Edit anything; they read it on every task.
            </p>
          </div>
          <div
            className="flex rounded-lg border border-border p-0.5"
            role="radiogroup"
            aria-label="Memory scope"
          >
            {(["project", "global"] as const).map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: segmented control; role and aria-checked are set.
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                disabled={s === "project" && !projectId}
                onClick={() => setScope(s)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs",
                  scope === s ? "bg-accent-soft text-fg" : "text-muted hover:text-fg disabled:opacity-50",
                )}
              >
                {s === "project" ? "This project" : "All projects"}
              </button>
            ))}
          </div>
        </header>

        {scope === "project" && !projectId ? (
          <p className="text-xs text-subtle">Open a project to see its memory.</p>
        ) : memory.isPending ? (
          <Loader2 className="size-5 animate-spin text-muted" aria-hidden />
        ) : memory.isError ? (
          <ErrorText error={memory.error} />
        ) : (
          <>
            <MarkdownEditor
              key={`md-${target ?? "global"}`}
              projectId={target}
              markdown={memory.data.markdown}
            />
            <FactList projectId={target} facts={others} />
            {scope === "project" && <LessonList lessons={lessons} />}
          </>
        )}
      </div>
    </section>
  );
}

function invalidate(projectId: string | null) {
  void queryClient.invalidateQueries({ queryKey: ["memory", projectId] });
  if (projectId) void queryClient.invalidateQueries({ queryKey: ["overview", projectId] });
}

function MarkdownEditor({ projectId, markdown }: { projectId: string | null; markdown: string }) {
  const [text, setText] = useState(markdown);
  const [base, setBase] = useState(markdown);
  // Take outside changes (an agent saved something) unless the user is editing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs only when the saved text changes.
  useEffect(() => {
    if (text === base) setText(markdown);
    setBase(markdown);
  }, [markdown]);
  const save = useMutation({
    mutationFn: () => call("memory.setMarkdown", { projectId, markdown: text }),
    onSuccess: () => {
      setBase(text);
      invalidate(projectId);
    },
  });
  const dirty = text !== base;
  return (
    <section aria-label={projectId ? "Project notes" : "General preferences"} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[13px] font-semibold text-fg">
          {projectId ? "Project notes" : "General preferences"}
        </h2>
        {dirty && <span className="text-[11px] text-warning">Unsaved changes</span>}
        <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save notes
        </Button>
      </div>
      <textarea
        aria-label={projectId ? "Project memory notes (Markdown)" : "Global memory notes (Markdown)"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        placeholder={
          projectId
            ? "How to run it, conventions, architecture notes, things agents must know…"
            : "Preferences for every project, e.g. 'Write tests with pytest' or 'Explain changes briefly'."
        }
        className={`${inputClass} field-in-frame h-auto py-2 font-mono text-[12px] leading-relaxed`}
      />
      <ErrorText error={save.error} />
    </section>
  );
}

function FactList({ projectId, facts }: { projectId: string | null; facts: MemoryFact[] }) {
  const [kind, setKind] = useState<Exclude<MemoryKind, "lesson">>(projectId ? "fact" : "preference");
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => call("memory.addFact", { projectId, kind, text: text.trim() }),
    onSuccess: () => {
      setText("");
      invalidate(projectId);
    },
  });
  return (
    <section aria-label="Facts" className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold text-fg">Facts, decisions and preferences</h2>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className={`${inputClass} w-32`}
        >
          <option value="fact">Fact</option>
          <option value="decision">Decision</option>
          <option value="preference">Preference</option>
        </select>
        <input
          aria-label="New memory item"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. The API listens on port 8000"
          maxLength={2000}
          className={inputClass}
        />
        <Button type="submit" size="sm" disabled={!text.trim() || add.isPending}>
          <Plus aria-hidden /> Add
        </Button>
      </form>
      <ErrorText error={add.error} />
      {facts.length === 0 ? (
        <p className="text-xs text-subtle">
          Nothing yet. Agents add items here with their remember tool, and so can you.
        </p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-border rounded-lg border border-border"
          aria-label="Memory items"
        >
          {facts.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FactRow({ fact }: { fact: MemoryFact }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);
  const update = useMutation({
    mutationFn: () => call("memory.updateFact", { id: fact.id, text: text.trim() }),
    onSuccess: () => {
      setEditing(false);
      invalidate(fact.projectId);
    },
  });
  const remove = useMutation({
    mutationFn: () => call("memory.deleteFact", { id: fact.id }),
    onSuccess: () => invalidate(fact.projectId),
  });
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-xs">
      <span className="mt-0.5 w-20 shrink-0 text-[11px] text-subtle">{KIND_LABEL[fact.kind]}</span>
      {editing ? (
        <form
          className="flex flex-1 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) update.mutate();
          }}
        >
          <input
            aria-label="Edit memory item"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
          />
          <Button type="submit" size="icon" aria-label="Save" disabled={update.isPending}>
            <Check aria-hidden />
          </Button>
          <Button size="icon" aria-label="Cancel" onClick={() => setEditing(false)}>
            <X aria-hidden />
          </Button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-fg">{fact.text}</span>
          <span className="shrink-0 text-[10px] text-subtle" title={fact.updatedAt}>
            {fact.source === "agent" ? "by agent · " : ""}
            {formatRelative(fact.updatedAt)}
          </span>
          <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(true)}>
            <Pencil aria-hidden />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => remove.mutate()}>
            <Trash2 aria-hidden />
          </Button>
        </>
      )}
    </li>
  );
}

function LessonList({ lessons }: { lessons: MemoryFact[] }) {
  return (
    <section aria-label="Lessons learned" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        <GraduationCap className="size-4 text-muted" aria-hidden /> Lessons learned
      </h2>
      {lessons.length === 0 ? (
        <p className="text-xs text-subtle">
          When an agent fixes a failing test, Depo remembers the error and the fix, and shows it the next time
          the same error appears.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {lessons.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
        </ul>
      )}
    </section>
  );
}
