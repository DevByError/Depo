import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, FolderPlus, Layers } from "lucide-react";
import { useState } from "react";
import {
  BLUEPRINT_PITCH,
  BlueprintFiles,
  StackChips,
  useBlueprints,
  WhatYouGet,
} from "@/components/blueprints/Blueprints";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const STACKS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ts", label: "TypeScript" },
  { id: "py", label: "Python" },
  { id: "react", label: "React" },
  { id: "docker", label: "Docker" },
];

export function BlocksPanel() {
  const status = useEngine((s) => s.status);
  const projectId = useUi((s) => s.projectId);
  const setTaskId = useUi((s) => s.setTaskId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const qc = useQueryClient();
  const blocks = useQuery({
    queryKey: ["blocks"],
    queryFn: () => call("blocks.list", {}),
    enabled: status === "open",
  });
  const [stack, setStack] = useState("all");
  const [text, setText] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      call("tasks.send", {
        projectId: projectId ?? "",
        text: `Add the "${v.name}" building block (id ${v.id}) to this project with the use_block tool, run its tests, and connect it to the existing code where it fits. Report what you wired and what is left for me.`,
      }),
    onSuccess: (t, v) => {
      setSentId(v.id);
      setTaskId(t.id);
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      setCenterTab("chat");
    },
  });

  const shown = (blocks.data?.blocks ?? []).filter(
    (b) =>
      (stack === "all" || b.stack === stack) &&
      (!text.trim() ||
        `${b.name} ${b.description} ${b.tags.join(" ")}`.toLowerCase().includes(text.trim().toLowerCase())),
  );

  return (
    <section className="h-full overflow-y-auto" tabIndex={0} aria-label="Blocks">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
        <BlueprintsSection enabled={status === "open"} />
        <header className="flex items-center gap-3">
          <Blocks className="size-5 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold text-fg">Building blocks</h1>
        </header>
        <p className="-mt-2 text-[13px] leading-relaxed text-muted">
          Tested pieces for the systems you build: login, roles, audit log, rate limits and more. The agents
          use them instead of writing security code from scratch. Adding one goes through the same Diff Review
          as any other change. Depo itself has no login.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Search blocks"
            placeholder="Search, for example login"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
          />
          <fieldset aria-label="Language" className="m-0 flex gap-1 border-0 p-0">
            {STACKS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={stack === s.id}
                onClick={() => setStack(s.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs",
                  stack === s.id ? "border-accent text-fg" : "border-border text-muted hover:text-fg",
                )}
              >
                {s.label}
              </button>
            ))}
          </fieldset>
        </div>
        {!projectId && <p className="text-xs text-muted">Open a project to add blocks to it.</p>}
        {add.isError && (
          <p role="alert" className="text-xs text-danger">
            {(add.error as Error).message}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {shown.map((b) => (
            <li key={b.id} className="rounded-lg border border-border bg-panel p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-fg">{b.name}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                  {b.stack}
                </span>
                <span className="text-xs text-subtle">{b.files.length} files</span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => setOpen(open === b.id ? null : b.id)}>
                    {open === b.id ? "Hide details" : "Details"}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!projectId || add.isPending}
                    onClick={() => add.mutate({ id: b.id, name: b.name })}
                  >
                    {sentId === b.id ? "Requested" : "Add to project"}
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted">{b.description}</p>
              {open === b.id && (
                <div className="mt-2 text-xs text-muted">
                  <div className="font-medium text-fg">Files</div>
                  <ul className="mb-2 font-mono text-[11px]">
                    {b.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <div className="font-medium text-fg">After adding it</div>
                  <ul className="list-disc pl-5">
                    {b.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                  {b.test && (
                    <p className="mt-2">
                      Its tests: <code>{b.test}</code>
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
          {shown.length === 0 && <li className="text-[13px] text-muted">No block matches.</li>}
        </ul>
      </div>
    </section>
  );
}

/** Whole starting points for a new project, above the pieces to add to one. */
function BlueprintsSection({ enabled }: { enabled: boolean }) {
  const blueprints = useBlueprints(enabled);
  const setProjectDialog = useUi((s) => s.setProjectDialog);
  const [files, setFiles] = useState<string | null>(null);
  const list = blueprints.data?.blueprints ?? [];
  const shown = list.find((b) => b.id === files);
  return (
    <section aria-labelledby="blueprints-title" className="@container flex flex-col gap-3">
      <header className="flex items-center gap-3">
        <Layers className="size-5 text-accent" aria-hidden />
        <h1 id="blueprints-title" className="text-lg font-semibold text-fg">
          Blueprints
        </h1>
      </header>
      <p className="-mt-2 text-[13px] leading-relaxed text-muted">
        {BLUEPRINT_PITCH} Start a new project from one here. In an empty project the agents pick the closest
        one themselves.
      </p>
      {blueprints.isError && (
        <p role="alert" className="text-xs text-danger">
          {(blueprints.error as Error).message}
        </p>
      )}
      <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @3xl:grid-cols-3">
        {list.map((b) => (
          <li key={b.id} className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
            <div>
              <h2 className="text-[13px] font-medium text-fg">{b.title}</h2>
              <p className="mt-0.5 text-xs text-muted">{b.summary}</p>
            </div>
            <StackChips stack={b.stack} />
            <WhatYouGet features={b.features} />
            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                aria-expanded={files === b.id}
                aria-controls="blueprint-files"
                aria-label={`${files === b.id ? "Hide files" : "Show files"} of ${b.title}`}
                onClick={() => setFiles(files === b.id ? null : b.id)}
              >
                {files === b.id ? "Hide files" : "Show files"}
              </Button>
              <Button
                size="sm"
                variant="primary"
                aria-label={`Start a project from ${b.title}`}
                onClick={() => setProjectDialog({ kind: "new", blueprint: b.id })}
              >
                <FolderPlus aria-hidden /> Start a project
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div id="blueprint-files">
        {shown && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
            <BlueprintFiles id={shown.id} title={shown.title} />
            <p className="text-[11px] text-subtle">
              Run it with <code className="font-mono">{shown.runCommand}</code>. Test it with{" "}
              <code className="font-mono">{shown.testCommand}</code>.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
