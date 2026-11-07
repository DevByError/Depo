import type { PageCheck, PreviewInfo } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, ScanSearch } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/engine";
import { formatRelative } from "@/lib/format";
import { agentName } from "@/lib/step-summary";
import { useEngine } from "@/store/engine";
import { type CheckTarget, PageCheckView } from "./PageCheckView";

const byText = (by: string) => (by === "user" ? "you" : agentName(by) || by);

/**
 * The Preview tab's page check: look at the running app at phone, tablet and desktop width in a
 * headless browser, then show the screenshots, console errors, failed requests and accessibility.
 * Also shows the newest check an agent made of this target.
 */
export function PageCheckSection({ target, preview }: { target: CheckTarget; preview: PreviewInfo | null }) {
  const connected = useEngine((s) => s.status === "open");
  const qc = useQueryClient();
  // An earlier check starts folded so the page itself stays in view; a check the owner runs opens.
  const [open, setOpen] = useState(false);
  const key = ["qa", "list", target.projectId, target.taskId];
  const params = { projectId: target.projectId, ...(target.taskId ? { taskId: target.taskId } : {}) };
  const latest = useQuery({
    queryKey: key,
    queryFn: () => call("qa.list", { ...params, limit: 1 }),
    enabled: connected,
    retry: false,
  });
  const check = useMutation({
    mutationFn: (url: string) => call("qa.check", { ...params, url }, { timeoutMs: 120_000 }),
    onSuccess: (r) => {
      qc.setQueryData(key, { checks: [r.check] });
      setOpen(true);
    },
  });
  const running = preview?.state === "running";
  const shown: PageCheck | null = latest.data?.checks[0] ?? null;
  const error = check.error as Error | null;
  return (
    <section
      aria-label="Page check"
      className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!running || check.isPending}
          onClick={() => preview && check.mutate(preview.url)}
        >
          {check.isPending ? <Loader2 className="animate-spin" /> : <ScanSearch />} Check this page
        </Button>
        <p className="min-w-0 flex-1 text-[11px] text-subtle">
          {check.isPending
            ? "Looking at the page at phone, tablet and desktop width. This takes a few seconds."
            : running
              ? "Screenshots at three widths, console errors, failed requests and accessibility."
              : "Start the app to check its page."}
        </p>
        {shown && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls="page-check-result"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronUp /> : <ChevronDown />} {open ? "Hide result" : "Show result"}
          </Button>
        )}
      </div>
      <p role="status" className="sr-only">
        {check.isPending ? "Checking the page" : check.isSuccess ? "Page check finished" : ""}
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error.message}
        </p>
      )}
      {shown && !open && (
        <p className="text-[11px] text-subtle">
          Checked by {byText(shown.by)} · {formatRelative(shown.at)} ·{" "}
          <span className={shown.ok ? "text-success" : "text-danger"}>
            {shown.ok ? "no problems found" : "problems found"}
          </span>
        </p>
      )}
      {shown && open && (
        <div id="page-check-result" className="rounded-md border border-border bg-panel px-3 py-2.5">
          <p className="mb-2 text-[11px] text-subtle">
            Checked by {byText(shown.by)} · {formatRelative(shown.at)} · {shown.url}
          </p>
          <PageCheckView key={shown.id} check={shown} target={target} />
        </div>
      )}
    </section>
  );
}
