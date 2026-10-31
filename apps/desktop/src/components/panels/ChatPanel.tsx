import { ArrowUp, FlaskConical, HardDrive, ShieldCheck } from "lucide-react";
import { useEngine } from "@/store/engine";
import { connectionLabel } from "./ConnectionBadge";

const PILLARS = [
  {
    icon: HardDrive,
    title: "Fully local",
    text: "Models run on this PC through Ollama, llama.cpp or LM Studio. No cloud, no login.",
  },
  {
    icon: ShieldCheck,
    title: "Safe edits",
    text: "Agents build and test in a shadow copy. You approve every change before it lands.",
  },
  {
    icon: FlaskConical,
    title: "Tested work",
    text: "A build, test and fix loop runs until the checks pass, then a different agent reviews.",
  },
];

export function ChatPanel() {
  const status = useEngine((s) => s.status);
  const statusError = useEngine((s) => s.statusError);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col px-6 pt-16 pb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">What should we build?</h1>
          <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-muted">
            Describe the software you want. The Manager Agent and its team will plan it, design it, build it,
            test it and show you every change before it touches your files.
          </p>

          {status !== "open" && (
            <div
              role="status"
              className="mt-6 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-fg"
            >
              <strong className="font-medium">Engine: {connectionLabel(status)}.</strong>{" "}
              <span className="text-muted">{statusError ?? "Starting the local engine…"}</span>
            </div>
          )}

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-lg border border-border bg-panel p-4">
                <Icon className="size-4 text-accent" aria-hidden />
                <h2 className="mt-2 text-[13px] font-semibold text-fg">{title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-border bg-panel px-6 py-4">
        <div className="mx-auto max-w-2xl">
          <label htmlFor="composer" className="sr-only">
            Message the Manager Agent
          </label>
          <div className="flex items-end gap-2 rounded-xl border border-border bg-bg p-2 opacity-70">
            <textarea
              id="composer"
              rows={2}
              disabled
              aria-describedby="composer-note"
              placeholder="e.g. A clinic booking system with Next.js, FastAPI and PostgreSQL…"
              className="min-h-10 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] text-fg outline-none placeholder:text-subtle"
            />
            <button
              type="button"
              disabled
              aria-label="Send"
              className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg disabled:opacity-50"
            >
              <ArrowUp className="size-4" aria-hidden />
            </button>
          </div>
          <p id="composer-note" className="mt-2 text-xs text-subtle">
            Chat opens in Phase 1, when the first local agent and model gateway are connected.
          </p>
        </div>
      </div>
    </div>
  );
}
