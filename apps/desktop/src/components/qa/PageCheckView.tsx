import type { PageCheck, PageView } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight, ImageOff, Loader2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import {
  type CheckCounts,
  checkCounts,
  IMPACTS,
  parseCheckId,
  viewProblems,
  WIDTH_LABEL,
  widthsText,
} from "@/lib/page-check";
import { plural } from "@/lib/step-summary";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

/** Where a check is stored: a task's private copy, or the project folder. */
export interface CheckTarget {
  projectId: string;
  taskId: string | null;
}

const targetParams = (t: CheckTarget) => ({
  projectId: t.projectId,
  ...(t.taskId ? { taskId: t.taskId } : {}),
});

/** A check screenshot as a data URL (the engine validates the path). */
function useCheckImage(target: CheckTarget, path: string | null) {
  const connected = useEngine((s) => s.status === "open");
  return useQuery({
    queryKey: ["qa", "image", target.projectId, target.taskId, path],
    queryFn: () => call("qa.screenshot", { ...targetParams(target), path: path ?? "" }),
    enabled: connected && !!path,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

const IMPACT_STYLE = {
  critical: "text-danger",
  serious: "text-danger",
  moderate: "text-warning",
  minor: "text-muted",
} as const;

/**
 * One page check: a thumbnail per width (click to see the whole page), the counts, and the problems
 * in a list. Page text shown here came from the app, so it is only ever rendered as text.
 */
export function PageCheckView({ check, target }: { check: PageCheck; target: CheckTarget }) {
  const counts = checkCounts(check);
  const [shown, setShown] = useState<PageView["width"] | null>(null);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const hasDetails =
    counts.consoleList.length > 0 ||
    counts.requestList.length > 0 ||
    counts.a11yList.length > 0 ||
    !!check.vision ||
    check.views.some((v) => v.error || v.steps.some((s) => !s.ok));
  return (
    <div className="flex flex-col gap-2.5">
      <p className="flex items-start gap-1.5 text-xs text-fg">
        {check.ok ? (
          <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
        ) : (
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
        )}
        <span className="min-w-0 break-words">
          <span className="sr-only">{check.ok ? "Passed. " : "Needs work. "}</span>
          {check.summary}
        </span>
      </p>
      <ul aria-label="Screenshots" className="flex flex-wrap items-end gap-2">
        {check.views.map((v) => (
          <li key={v.width}>
            <Thumbnail view={v} target={target} onOpen={() => setShown(v.width)} />
          </li>
        ))}
      </ul>
      <Counts counts={counts} ran={check.views.some((v) => v.a11y.ran)} />
      {hasDetails && (
        <div>
          <button
            type="button"
            onClick={() => setDetails((d) => !d)}
            aria-expanded={details}
            aria-controls={details ? detailsId : undefined}
            className="group -mx-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg"
          >
            <ChevronRight
              className={cn("size-3 shrink-0 transition-transform", details && "rotate-90")}
              aria-hidden
            />
            {details ? "Hide the problems" : "Show the problems"}
          </button>
          {details && <Problems id={detailsId} check={check} counts={counts} />}
        </div>
      )}
      {shown && (
        <Lightbox
          check={check}
          target={target}
          width={shown}
          onWidth={setShown}
          onClose={() => setShown(null)}
        />
      )}
    </div>
  );
}

function Thumbnail({ view, target, onOpen }: { view: PageView; target: CheckTarget; onOpen: () => void }) {
  const img = useCheckImage(target, view.thumbnail);
  const problems = viewProblems(view);
  const label = WIDTH_LABEL[view.width];
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!view.screenshot}
      className="group flex flex-col items-start gap-1 rounded-md p-1 text-left hover:bg-hover disabled:pointer-events-none"
    >
      <span className="flex h-28 items-start overflow-hidden rounded border border-border bg-bg">
        {img.data ? (
          <img
            src={img.data.dataUrl}
            alt=""
            className="block h-full w-auto max-w-56 object-cover object-top"
          />
        ) : (
          <span
            className="flex h-full items-center justify-center text-subtle"
            style={{ width: Math.round((112 * view.viewport.width) / view.viewport.height) }}
          >
            {img.isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ImageOff className="size-4" aria-hidden />
            )}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1 text-[11px]">
        <span className="text-fg">{label}</span>
        <span className="text-subtle">{view.viewport.width}px</span>
        <span className={problems ? "text-warning" : "text-success"}>
          {view.error ? "did not load" : problems ? plural(problems, "problem") : "OK"}
        </span>
        {view.screenshot && <span className="sr-only">, show it larger</span>}
      </span>
    </button>
  );
}

function Counts({ counts, ran }: { counts: CheckCounts; ran: boolean }) {
  const a11y = IMPACTS.filter((i) => counts.a11y[i] > 0);
  const items: { text: string; tone: string }[] = [
    {
      text: plural(counts.console, "console error"),
      tone: counts.console ? "text-danger" : "text-muted",
    },
    {
      text: plural(counts.requests, "failed request"),
      tone: counts.requests ? "text-danger" : "text-muted",
    },
  ];
  if (counts.blocked) items.push({ text: `${counts.blocked} blocked`, tone: "text-warning" });
  if (!ran) items.push({ text: "Accessibility not checked", tone: "text-muted" });
  else if (!a11y.length) items.push({ text: "No accessibility issues", tone: "text-muted" });
  else for (const i of a11y) items.push({ text: `${counts.a11y[i]} ${i}`, tone: IMPACT_STYLE[i] });
  return (
    <ul aria-label="Counts" className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <li
          key={it.text}
          className={cn("rounded-full border border-border bg-raised px-2 py-0.5 text-[11px]", it.tone)}
        >
          {it.text}
        </li>
      ))}
    </ul>
  );
}

function Problems({ id, check, counts }: { id: string; check: PageCheck; counts: CheckCounts }) {
  const n = check.views.length;
  const broken = check.views.filter((v) => v.error);
  const steps = check.views.flatMap((v) =>
    v.steps.filter((s) => !s.ok).map((s) => ({ ...s, width: v.width })),
  );
  return (
    <div id={id} className="mt-1 flex flex-col gap-2 text-[11.5px]">
      {(broken.length > 0 || steps.length > 0) && (
        <Group title="Did not work">
          {broken.map((v) => (
            <li key={v.width}>
              {WIDTH_LABEL[v.width]}: {v.error}
            </li>
          ))}
          {steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps of one check, in order
            <li key={i}>
              {s.label} ({s.width}): {s.error}
            </li>
          ))}
        </Group>
      )}
      {counts.consoleList.length > 0 && (
        <Group title="Console errors">
          {counts.consoleList.slice(0, 8).map((c) => (
            <li key={`${c.kind}|${c.text}`} className="break-words">
              <span className="font-mono text-[11px] text-fg">{c.text.slice(0, 300)}</span>
              {c.source && <span className="text-subtle"> · {c.source}</span>}
              <span className="text-subtle"> · {widthsText(c.widths, n)}</span>
            </li>
          ))}
        </Group>
      )}
      {counts.requestList.length > 0 && (
        <Group title="Failed requests">
          {counts.requestList.slice(0, 8).map((r) => (
            <li key={r.label} className="break-all">
              <span className={cn("font-mono text-[11px]", r.blocked ? "text-warning" : "text-fg")}>
                {r.label}
              </span>
              <span className="text-subtle"> · {widthsText(r.widths, n)}</span>
            </li>
          ))}
        </Group>
      )}
      {counts.a11yList.length > 0 && (
        <Group title="Accessibility (axe-core)">
          {counts.a11yList.slice(0, 10).map((a) => (
            <li key={a.id} className="break-words">
              <span className={cn("font-medium", IMPACT_STYLE[a.impact ?? "minor"])}>
                {a.impact ?? "unknown"}
              </span>{" "}
              <span className="text-fg">{a.help}</span>
              <span className="text-subtle">
                {" "}
                · {a.id}, {plural(a.count, "place")} · {widthsText(a.widths, n)}
              </span>
            </li>
          ))}
        </Group>
      )}
      {check.vision && (
        <Group title="What the vision model saw">
          <li className="break-words whitespace-pre-wrap">{check.vision}</li>
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h4 className="mb-0.5 text-[11px] font-medium text-fg">{title}</h4>
      <ul className="flex flex-col gap-0.5 pl-1 text-muted">{children}</ul>
    </section>
  );
}

function Lightbox({
  check,
  target,
  width,
  onWidth,
  onClose,
}: {
  check: PageCheck;
  target: CheckTarget;
  width: PageView["width"];
  onWidth: (w: PageView["width"]) => void;
  onClose: () => void;
}) {
  const view = check.views.find((v) => v.width === width) ?? check.views[0];
  const img = useCheckImage(target, view?.screenshot ?? null);
  if (!view) return null;
  const label = WIDTH_LABEL[view.width];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${label} screenshot, ${view.viewport.width}px wide`}
      description={view.title ? `${view.title} · ${check.url}` : check.url}
      className="w-[min(1100px,calc(100vw-32px))]"
    >
      {check.views.length > 1 && (
        <fieldset className="m-0 mb-2 flex flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">Width</legend>
          {check.views.map((v) => (
            <button
              key={v.width}
              type="button"
              aria-pressed={v.width === view.width}
              onClick={() => onWidth(v.width)}
              className={cn(
                "h-7 rounded-md px-2 text-xs",
                v.width === view.width ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {WIDTH_LABEL[v.width]}
            </button>
          ))}
        </fieldset>
      )}
      <figure
        tabIndex={0}
        aria-label={`${label} screenshot`}
        className="m-0 max-h-[70vh] overflow-auto rounded-md border border-border bg-bg"
      >
        {img.data ? (
          <img
            src={img.data.dataUrl}
            alt={`The page at ${label.toLowerCase()} width`}
            className="mx-auto block h-auto max-w-full"
          />
        ) : (
          <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted">
            {img.isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the screenshot
              </>
            ) : (
              <>
                <ImageOff className="size-4" aria-hidden /> This screenshot is no longer there.
              </>
            )}
          </div>
        )}
      </figure>
      <p className="mt-2 text-[11px] text-subtle">Press Escape to close.</p>
    </Modal>
  );
}

/** check_page in the chat's work log: the check itself, or the agent's text when it is gone. */
export function PageCheckStep({ text }: { text: string }) {
  const connected = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const taskId = useUi((s) => s.taskId);
  const id = parseCheckId(text);
  const q = useQuery({
    queryKey: ["qa", "check", projectId, taskId, id],
    queryFn: () =>
      call("qa.get", { projectId: projectId ?? "", ...(taskId ? { taskId } : {}), id: id ?? "" }),
    enabled: connected && !!projectId && !!id,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (q.data && projectId)
    return (
      <div className="px-2.5 py-2">
        <PageCheckView check={q.data.check} target={{ projectId, taskId }} />
      </div>
    );
  return (
    <figure tabIndex={0} aria-label="Output of check_page" className="m-0 max-h-72 overflow-auto">
      {q.isLoading && (
        <p className="flex items-center gap-1.5 px-2.5 pt-2 text-[11px] text-muted">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Loading the screenshots
        </p>
      )}
      {q.isError && (
        <p className="px-2.5 pt-2 text-[11px] text-muted">The screenshots of this check are gone.</p>
      )}
      <pre className="px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted">
        {text.trim() || "No output."}
      </pre>
    </figure>
  );
}
