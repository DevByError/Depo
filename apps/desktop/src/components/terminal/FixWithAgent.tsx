import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { call } from "@/lib/engine";
import { fixDestination } from "@/lib/fix-request";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

/**
 * "Fix with an agent": a button that opens a drafted request the owner can edit, then starts a
 * task (or continues the task whose private copy it came from, when that task is in review or
 * done) and switches to Chat on it.
 */
export function FixWithAgent({
  draft,
  taskId,
  label = "Fix with an agent",
  compact = false,
}: {
  /** Builds the request when the dialog opens. */
  draft: () => string | Promise<string>;
  /** The task whose private copy it ran in, or null for the project folder. */
  taskId: string | null;
  /** The button's accessible name (say what it fixes when there are many on screen). */
  label?: string;
  /** An icon-only button, for rows. */
  compact?: boolean;
}) {
  const projectId = useUi((s) => s.projectId);
  const connected = useEngine((s) => s.status === "open");
  const [open, setOpen] = useState(false);
  const disabled = !projectId || !connected;
  return (
    <>
      {compact ? (
        <Tooltip content={label}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            className="size-6 [&_svg]:size-3.5"
          >
            <Wand2 />
          </Button>
        </Tooltip>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Wand2 aria-hidden />
          Fix with an agent
        </Button>
      )}
      {open && projectId && (
        <FixDialog projectId={projectId} taskId={taskId} draft={draft} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function FixDialog({
  projectId,
  taskId,
  draft,
  onClose,
}: {
  projectId: string;
  taskId: string | null;
  draft: () => string | Promise<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const setTaskId = useUi((s) => s.setTaskId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const [text, setText] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<unknown>(null);

  // The draft is built once, when the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is a fresh function each render
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(draft)
      .then(
        (t) => !cancelled && setText(t),
        (err: unknown) => {
          if (cancelled) return;
          setDraftError(err);
          setText("");
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const tasks = useQuery({
    queryKey: ["tasks", "list", projectId],
    queryFn: () => call("tasks.list", { projectId }),
    enabled: !!taskId,
  });
  const dest = fixDestination(taskId, tasks.data?.tasks ?? []);

  const start = useMutation({
    mutationFn: (body: string) =>
      call("tasks.send", { projectId, text: body, ...(dest ? { taskId: dest.id } : {}) }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      setTaskId(t.id);
      setCenterTab("chat");
      onClose();
    },
  });

  const body = text?.trim() ?? "";
  const waitingForTasks = !!taskId && tasks.isPending;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Fix with an agent"
      description="Depo drafted the request. Edit it if you like, then start. The agent works in a private copy, and you review the changes before they reach your files."
      className="w-[min(680px,calc(100vw-32px))]"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (body) start.mutate(body);
        }}
      >
        <Field label="Request">
          <textarea
            value={text ?? ""}
            onChange={(e) => setText(e.target.value)}
            placeholder={text === null ? "Drafting the request…" : "Say what to fix."}
            maxLength={20_000}
            rows={14}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-border bg-bg p-2 font-mono text-[12px] leading-relaxed text-fg outline-none placeholder:text-subtle focus:border-accent"
          />
        </Field>
        {draftError !== null && (
          <p className="text-xs text-muted">The draft could not be built, so write what to fix yourself.</p>
        )}
        <p className="text-xs text-muted">
          {waitingForTasks
            ? "Checking the task…"
            : dest
              ? `This continues the task "${dest.title}" in the same private copy.`
              : "This starts a new task."}
        </p>
        <ErrorText error={start.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!body || start.isPending || waitingForTasks}>
            {start.isPending ? "Starting…" : "Start"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
