import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Moon, Sun, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { call, setTheme } from "@/lib/engine";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { type Theme, useUi } from "@/store/ui";
import { NotificationSetting, TeamSettings, UpdateSetting } from "./SettingsSections";

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const theme = useUi((s) => s.theme);
  const info = useEngine((s) => s.info);

  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "dark", label: "Dark", icon: Moon },
    { value: "light", label: "Light", icon: Sun },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[88vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-panel p-5 shadow-2xl">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-fg">Settings</Dialog.Title>
            <Dialog.Close
              className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
              aria-label="Close"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-xs text-muted">
            Saved in the local Depo database. More settings arrive with their features.
          </Dialog.Description>

          <fieldset className="mt-5">
            <legend className="mb-2 text-xs font-medium text-fg">Theme</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {options.map(({ value, label, icon: Icon }) => (
                // biome-ignore lint/a11y/useSemanticElements: styled radio cards; role and aria-checked are set.
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  onClick={() => void setTheme(value)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors",
                    theme === value
                      ? "border-accent bg-accent-soft text-fg"
                      : "border-border text-muted hover:bg-hover",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <ParallelSetting />
          <TeamSettings />
          <NotificationSetting />
          <UpdateSetting />

          {info && (
            <dl className="mt-5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-subtle">Data folder</dt>
              <dd className="break-all font-mono text-[11px] text-muted">{info.dataDir}</dd>
              <dt className="text-subtle">Engine</dt>
              <dd className="text-muted">
                {info.engineVersion} ({info.runtime})
              </dd>
            </dl>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** How many model requests run at once across all projects. One GPU usually serves one well. */
function ParallelSetting() {
  const connected = useEngine((s) => s.status === "open");
  const status = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => call("scheduler.status", {}),
    enabled: connected,
  });
  const set = useMutation({
    mutationFn: (maxParallel: number) => call("scheduler.configure", { maxParallel }),
    onSuccess: (s) => queryClient.setQueryData(["scheduler"], s),
  });
  const value = status.data?.maxParallel ?? 1;
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Model requests at once</legend>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        Tasks from every project share this. With one GPU, 1 is fastest overall: other tasks wait in a queue
        and their tests and builds still run in parallel. Raise it only if your runtime serves several
        requests at once.
      </p>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Model requests at once">
        {[1, 2, 3, 4].map((n) => (
          // biome-ignore lint/a11y/useSemanticElements: styled radio cards; role and aria-checked are set.
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            disabled={!connected || set.isPending}
            onClick={() => set.mutate(n)}
            className={cn(
              "h-8 w-10 rounded-md border text-[13px] tabular-nums",
              value === n
                ? "border-accent bg-accent-soft text-fg"
                : "border-border text-muted hover:bg-hover",
            )}
          >
            {n}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
