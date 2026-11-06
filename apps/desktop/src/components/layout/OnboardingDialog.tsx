import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const STEPS = ["Welcome", "Your computer", "Your first project", "Try it"] as const;

/** First-run tour: what Depo is, what the computer can run, how to start. Shown once. */
export function OnboardingDialog() {
  const open = useUi((s) => s.onboardingOpen);
  const setOpen = useUi((s) => s.setOnboardingOpen);
  const connected = useEngine((s) => s.status === "open");
  const [step, setStep] = useState(0);
  const hw = useQuery({
    queryKey: ["hardware"],
    queryFn: () => call("hardware.get", {}),
    enabled: connected && open,
  });
  const installed = useQuery({
    queryKey: ["models", "installed"],
    queryFn: () => call("models.installed", {}),
    enabled: connected && open,
  });

  const finish = () => {
    setOpen(false);
    setStep(0);
    void call("settings.set", { key: "ui.onboarded", value: true }).catch(() => {});
  };
  const go = (tab: Parameters<ReturnType<typeof useUi.getState>["setCenterTab"]>[0]) => {
    useUi.getState().setCenterTab(tab);
    finish();
  };
  const p = hw.data?.profile;
  const gpu = p?.gpus[0];
  const modelCount = installed.data?.models?.length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? setOpen(true) : finish())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-6 shadow-2xl">
          <ol className="mb-4 flex gap-1.5" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li
                key={s}
                aria-current={i === step ? "step" : undefined}
                className={`h-1 flex-1 rounded-full ${i <= step ? "bg-accent" : "bg-border"}`}
                title={s}
              />
            ))}
          </ol>
          <Dialog.Title className="text-lg font-semibold text-fg">
            {step === 0 && "Welcome to Depo"}
            {step === 1 && "What your computer can run"}
            {step === 2 && "Start with a project"}
            {step === 3 && "Ask for something small first"}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Step {step + 1} of 4 of the welcome tour.
          </Dialog.Description>

          <div className="mt-3 min-h-40 text-[13px] leading-relaxed text-muted">
            {step === 0 && (
              <div className="flex flex-col gap-2">
                <p>
                  Depo is a team of AI specialists that plans, designs, builds, tests and documents software
                  on your own computer. Everything runs locally: no cloud models, no account, no cost per
                  request.
                </p>
                <p>
                  You stay in charge. The team works in a private copy of your project and shows you every
                  change as a diff. Nothing touches your real files until you approve it, and you can undo it.
                </p>
              </div>
            )}
            {step === 1 && (
              <div className="flex flex-col gap-2">
                {p ? (
                  <ul className="list-disc pl-5">
                    <li>
                      Memory: {p.ramGB.toFixed(0)} GB
                      {p.diskFreeGB !== null ? `, ${p.diskFreeGB.toFixed(0)} GB free on disk` : ""}
                    </li>
                    <li>
                      Graphics card:{" "}
                      {gpu
                        ? `${gpu.name} (${gpu.vramGB.toFixed(0)} GB video memory)`
                        : "none found, so models will use the processor"}
                    </li>
                    <li>Processor: {p.cpu.model}</li>
                  </ul>
                ) : (
                  <p>Checking your computer…</p>
                )}
                <p>
                  {modelCount > 0
                    ? `You already have ${modelCount} model${modelCount === 1 ? "" : "s"} installed.`
                    : "No model is installed yet. The Models tab picks the best one that fits this computer and downloads it when you say so."}
                </p>
              </div>
            )}
            {step === 2 && (
              <div className="flex flex-col gap-2">
                <p>
                  Create a new project, or import a folder or a GitHub repository you already have. Depo reads
                  it, builds a map of the code, and remembers decisions between sessions.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      useUi.getState().setProjectDialog({ kind: "new" });
                      finish();
                    }}
                  >
                    New project
                  </Button>
                  <Button
                    onClick={() => {
                      useUi.getState().setProjectDialog({ kind: "import" });
                      finish();
                    }}
                  >
                    Import a project
                  </Button>
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="flex flex-col gap-2">
                <p>
                  Open Chat and describe one small change, such as "add a health check endpoint with a test".
                  Watch the work in the Activity panel, then review the diff.
                </p>
                <p>
                  Pick <strong className="text-fg">Work mode</strong> in Chat for a whole team: Full system,
                  Backend only, Fix a bug, Refactor and more. Press{" "}
                  <kbd className="rounded border border-border px-1">Ctrl</kbd>+
                  <kbd className="rounded border border-border px-1">K</kbd> any time to find a screen or an
                  action.
                </p>
                <div className="flex flex-wrap gap-2">
                  {!installed.isLoading && modelCount === 0 && (
                    <Button onClick={() => go("models")}>Set up models</Button>
                  )}
                  <Button variant="primary" onClick={() => go("chat")}>
                    Open Chat
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center">
            <button type="button" onClick={finish} className="text-xs text-muted hover:text-fg">
              Skip the tour
            </button>
            <div className="ml-auto flex gap-2">
              {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
              {step < STEPS.length - 1 ? (
                <Button variant="primary" onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" onClick={finish}>
                  Done
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
