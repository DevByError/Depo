import { STEER_MAX_CHARS, type Task, type WorkMode } from "@depo/shared";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, Loader2, Square, User, Users } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useComposer } from "@/store/composer";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

export const MODES: { id: WorkMode; label: string; description: string }[] = [
  {
    id: "single",
    label: "Single agent",
    description: "One coding agent makes the change and runs your tests.",
  },
  {
    id: "full",
    label: "Full system",
    description: "The whole team plans, designs, builds, tests and documents.",
  },
  {
    id: "backend",
    label: "Backend only",
    description: "Data model, API and server logic, then the full test suite.",
  },
  {
    id: "frontend",
    label: "Frontend only",
    description: "Design system and screens, then tests and a UX check.",
  },
  { id: "ai", label: "AI integration", description: "Adds a local AI feature and wires it into your app." },
  {
    id: "import",
    label: "Study project",
    description: "Learns how the project works and writes an overview.",
  },
  { id: "fix", label: "Fix / debug", description: "Reproduces the bug with a test, then fixes the cause." },
  {
    id: "refactor",
    label: "Refactor / upgrade",
    description: "Plans the change and checks the tests before and after.",
  },
  { id: "ask", label: "Ask / explain", description: "Answers a question about the code. Changes nothing." },
  { id: "business", label: "Business", description: "Writes a business brief with a roadmap and risks." },
];

/** About 8 lines of text, then the box scrolls. */
const MAX_TEXTAREA_PX = 172;

const isRunning = (s: Task["status"] | undefined) => s === "queued" || s === "running" || s === "waiting";

function ModePicker({ mode, onChange }: { mode: WorkMode; onChange: (m: WorkMode) => void }) {
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const Icon = mode === "single" ? User : Users;
  return (
    // Not modal: the rest of the window stays readable to screen readers while the small menu is open.
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Work mode: ${current?.label ?? ""}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover"
      >
        <Icon className="size-3.5" aria-hidden />
        {current?.label}
        <ChevronDown className="size-3 text-subtle" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 overflow-y-auto rounded-lg border border-border bg-panel p-1 shadow-pop"
        >
          <Menu.Label className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-subtle">
            How should Depo work?
          </Menu.Label>
          <Menu.RadioGroup value={mode} onValueChange={(v) => onChange(v as WorkMode)}>
            {MODES.map((m, i) => (
              <div key={m.id}>
                {i === 1 && (
                  <>
                    <Menu.Separator className="my-1 h-px bg-border" />
                    <Menu.Label className="px-2 pt-1 pb-1 text-[11px] font-medium text-subtle">
                      With the team
                    </Menu.Label>
                  </>
                )}
                <Menu.RadioItem
                  value={m.id}
                  className="flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover"
                >
                  <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                    <Menu.ItemIndicator>
                      <Check className="size-3.5 text-accent" aria-hidden />
                    </Menu.ItemIndicator>
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] text-fg">{m.label}</span>
                    <span className="text-[11.5px] leading-snug text-muted">{m.description}</span>
                  </span>
                </Menu.RadioItem>
              </div>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function Composer({ task, onSent }: { task: Task | undefined; onSent?: () => void }) {
  const connected = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const setTaskId = useUi((s) => s.setTaskId);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<WorkMode>("single");
  const running = isRunning(task?.status);
  // While the task works, the composer adds a note the agents read at their next step.
  const steering = running && !!task;
  const team = !!task && task.mode !== "single";
  const [sentNote, setSentNote] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Text another screen left for the composer ("Change this" in Files): taken once, caret placed.
  const prefilled = useComposer((s) => s.pending);
  const caret = useRef<number | null>(null);
  useEffect(() => {
    if (!prefilled) return;
    const p = useComposer.getState().take();
    if (!p) return;
    caret.current = p.cursor;
    setText(p.text);
    if (p.mode) setMode(p.mode);
  }, [prefilled]);

  // "Note sent" shows for a few seconds, then the usual hint comes back.
  useEffect(() => {
    if (!sentNote) return;
    const t = setTimeout(() => setSentNote(false), 4000);
    return () => clearTimeout(t);
  }, [sentNote]);

  // Grow with the text, up to about 8 lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again whenever the text changes
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "0px";
    const h = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${Math.max(h, 24)}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? "auto" : "hidden";
    if (caret.current !== null) {
      el.focus();
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);

  const send = useMutation({
    mutationFn: async (body: string): Promise<{ taskId: string; queued: boolean }> => {
      // A working task gets a steering note (it becomes a follow-up if the task just finished).
      if (task && steering) {
        const r = await call("tasks.steer", { taskId: task.id, text: body });
        return { taskId: r.taskId, queued: r.delivery === "queued" };
      }
      const t = await call("tasks.send", {
        projectId: projectId ?? "",
        text: body,
        ...(task ? { taskId: task.id } : {}),
        ...(!task && mode !== "single" ? { mode } : {}),
      });
      return { taskId: t.id, queued: false };
    },
    onSuccess: (r) => {
      setText("");
      setTaskId(r.taskId);
      setSentNote(r.queued);
      onSent?.();
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const stop = useMutation({
    mutationFn: () => call("tasks.cancel", { id: task?.id ?? "" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const body = text.trim();
  const tooLong = steering && body.length > STEER_MAX_CHARS;
  const canSend = connected && !!projectId && body.length > 0 && !tooLong && !send.isPending;
  const submit = () => {
    if (canSend) send.mutate(body);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const note = !projectId
    ? "Open a project to start."
    : tooLong
      ? `Notes can be up to ${STEER_MAX_CHARS.toLocaleString()} characters. Shorten it, or send it once the work is done.`
      : sentNote
        ? "Note sent. It will be read at the next step."
        : steering
          ? team
            ? "The team is working. Add a note and the Manager and the agents at work read it at their next step."
            : "The agent is working. Add a note and it reads it at its next step."
          : task
            ? "A follow-up continues this task in the same private copy."
            : "Depo works in a private copy. You approve every change.";

  return (
    <div className="border-t border-border bg-panel px-6 pt-3 pb-3">
      <div className="mx-auto max-w-3xl">
        <label htmlFor="composer" className="sr-only">
          Message the coding agent
        </label>
        <div
          className={cn(
            "flex flex-col rounded-xl border border-border bg-bg px-2.5 pt-2 pb-1.5 transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent",
            !projectId && "opacity-70",
          )}
        >
          <textarea
            ref={boxRef}
            id="composer"
            rows={1}
            value={text}
            disabled={!projectId || !connected}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-describedby="composer-note composer-keys"
            placeholder={
              steering
                ? team
                  ? "Add a note for the team…"
                  : "Add a note for the agent…"
                : task
                  ? "Ask for a follow-up change…"
                  : "Describe the change, e.g. Add a /health endpoint"
            }
            className="field-in-frame w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-5 text-fg outline-none placeholder:text-subtle"
          />
          <div className="mt-1.5 flex items-center gap-2">
            {!task && <ModePicker mode={mode} onChange={setMode} />}
            <span className="flex-1" />
            {running && (
              <button
                type="button"
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-raised px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:opacity-50"
              >
                {stop.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Square className="size-3 fill-current text-danger" aria-hidden />
                )}
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={steering ? "Send note" : "Send"}
              title={steering ? "Send note (Enter)" : undefined}
              className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {send.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex items-start gap-3 px-1 text-[11px]">
          <p
            id="composer-note"
            className={cn(
              "min-w-0 flex-1",
              send.isError || tooLong ? "text-danger" : sentNote ? "text-success" : "text-subtle",
            )}
          >
            {send.isError ? (send.error as Error).message : note}
          </p>
          <p id="composer-keys" className="hidden shrink-0 text-subtle sm:block">
            <Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line
          </p>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {sentNote ? "Note sent. It will be read at the next step." : ""}
        </p>
      </div>
    </div>
  );
}
