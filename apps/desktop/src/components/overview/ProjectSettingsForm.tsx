import type { ProjectSettings } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, inputClass } from "@/components/ui/modal";
import { call } from "@/lib/engine";
import { queryClient } from "@/lib/query";

/** Project settings, folded away at the bottom of the home until the owner needs them. */
export function ProjectSettingsSection({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded-xl border border-border bg-panel"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold text-fg hover:bg-hover [&::-webkit-details-marker]:hidden">
        <Settings2 className="size-4 text-muted" aria-hidden />
        <span className="flex-1">Project settings</span>
        <span className="text-[11px] font-normal text-subtle">Index, pace, steps and commands</span>
        <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      {open && (
        <div className="border-t border-border p-4">
          <ProjectSettingsForm projectId={projectId} />
        </div>
      )}
    </details>
  );
}

export function ProjectSettingsForm({ projectId }: { projectId: string }) {
  const settings = useQuery({
    queryKey: ["projectSettings", projectId],
    queryFn: () => call("projects.settings.get", { id: projectId }),
  });
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  useEffect(() => {
    if (settings.data) {
      setDraft(settings.data);
      setAllow(settings.data.commandAllow.join("\n"));
      setDeny(settings.data.commandDeny.join("\n"));
    }
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (patch: Partial<ProjectSettings>) => call("projects.settings.set", { id: projectId, patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(["projectSettings", projectId], next);
      void queryClient.invalidateQueries({ queryKey: ["overview", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["codemap", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["scheduler"] });
    },
  });
  if (!draft) return <ErrorText error={settings.error} />;
  const lines = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  return (
    <form
      aria-label="Project settings"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ ...draft, commandAllow: lines(allow), commandDeny: lines(deny) });
      }}
    >
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
        <Toggle
          label="Keep a code index"
          hint="Symbols, search and the code map for agents. Updates as files change."
          checked={draft.indexEnabled}
          onChange={(v) => setDraft({ ...draft, indexEnabled: v })}
        />
        <Toggle
          label="Pause this project"
          hint="Its tasks keep their place but start no new model work."
          checked={draft.paused}
          onChange={(v) => setDraft({ ...draft, paused: v })}
        />
        <Field
          label="Tasks at once"
          hint="How many of this project's tasks may use the model at the same time."
        >
          <input
            type="number"
            min={1}
            max={8}
            value={draft.maxParallel}
            onChange={(e) => setDraft({ ...draft, maxParallel: Number(e.target.value) || 1 })}
            className={inputClass}
          />
        </Field>
        <Field label="Most steps per task" hint="A task stops and hands over after this many model steps.">
          <input
            type="number"
            min={5}
            max={200}
            value={draft.maxSteps}
            onChange={(e) => setDraft({ ...draft, maxSteps: Number(e.target.value) || 40 })}
            className={inputClass}
          />
        </Field>
        <Field
          label="Commands to run without asking"
          hint="One per line, matched at the start, e.g. npm run lint. Never overrides Depo's blocked list."
        >
          <textarea
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
            rows={3}
            className={`${inputClass} field-in-frame h-auto py-1.5 font-mono text-[11px]`}
          />
        </Field>
        <Field label="Commands to block" hint="One per line. Agents are refused these in this project.">
          <textarea
            value={deny}
            onChange={(e) => setDeny(e.target.value)}
            rows={3}
            className={`${inputClass} field-in-frame h-auto py-1.5 font-mono text-[11px]`}
          />
        </Field>
      </div>
      <ErrorText error={save.error} />
      <div className="flex items-center justify-end gap-2">
        {save.isSuccess && !save.isPending && (
          <span role="status" className="text-xs text-success">
            Saved
          </span>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium text-fg">{label}</span>
        <span className="mt-0.5 block text-[11px] text-subtle">{hint}</span>
      </span>
    </label>
  );
}
