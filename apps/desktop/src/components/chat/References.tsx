import type { DesignReference, Swatch, SwatchRole } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Globe, ImageIcon, Loader2, Palette, X } from "lucide-react";
import { useId, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { type DraftReference, referenceSummary } from "@/lib/references";
import { useEngine } from "@/store/engine";

/**
 * Design references: the chips in the composer before sending, and under a sent message the
 * picture or screenshot with the colours, fonts and notes Depo read from it.
 */

const ROLE_LABEL: Record<SwatchRole, string> = {
  background: "Background",
  surface: "Surface",
  border: "Border",
  text: "Text",
  muted: "Muted text",
  primary: "Primary",
  accent: "Accent",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
};

/** The references waiting in the composer, each with a remove button. */
export function DraftChips({
  drafts,
  onRemove,
}: {
  drafts: DraftReference[];
  onRemove: (key: string) => void;
}) {
  if (!drafts.length) return null;
  return (
    <ul aria-label="Design references to send" className="mb-1.5 flex flex-wrap gap-1.5">
      {drafts.map((d) => (
        <li
          key={d.key}
          className="flex h-10 max-w-60 items-center gap-2 rounded-lg border border-border bg-raised py-1 pr-1 pl-1"
        >
          {d.preview ? (
            <img
              src={d.preview}
              alt=""
              className="size-8 shrink-0 rounded-md border border-border object-cover"
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              {d.input.kind === "link" ? (
                <Globe className="size-4" aria-hidden />
              ) : (
                <ImageIcon className="size-4" aria-hidden />
              )}
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium text-fg">{d.name}</span>
            <span className="text-[10.5px] text-subtle">
              {d.input.kind === "link" ? "Website" : "Picture"}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(d.key)}
            aria-label={`Remove ${d.name}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function useReferenceImage(taskId: string, ref: DesignReference) {
  const connected = useEngine((s) => s.status === "open");
  return useQuery({
    queryKey: ["references", "image", taskId, ref.id, ref.state],
    queryFn: () => call("references.image", { taskId, id: ref.id }),
    enabled: connected && ref.hasImage,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  });
}

const ROLE_ORDER = Object.keys(ROLE_LABEL) as SwatchRole[];
const SHOWN_ORDER: SwatchRole[] = ["background", "surface", "text", "muted", "primary", "accent", "border"];

function Swatches({ palette }: { palette: Swatch[] }) {
  const rank = (s: Swatch) => {
    const i = SHOWN_ORDER.indexOf(s.role as SwatchRole);
    return i >= 0 ? i : SHOWN_ORDER.length + ROLE_ORDER.indexOf(s.role as SwatchRole);
  };
  const named = palette.filter((s) => s.role).sort((a, b) => rank(a) - rank(b));
  const shown = (named.length ? named : palette).slice(0, 8);
  return (
    <ul aria-label="Colours" className="flex flex-wrap gap-x-3 gap-y-1.5">
      {shown.map((s) => (
        <li key={`${s.hex}-${s.role ?? ""}`} className="flex items-center gap-1.5">
          <span
            className="size-4 shrink-0 rounded-[5px] border border-border-strong"
            style={{ backgroundColor: s.hex }}
            aria-hidden
          />
          <span className="flex flex-col leading-tight">
            <span className="text-[10.5px] text-subtle">{s.role ? ROLE_LABEL[s.role] : "Colour"}</span>
            <span className="font-mono text-[11px] text-fg">{s.hex}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReferenceCard({ taskId, item }: { taskId: string; item: DesignReference }) {
  const img = useReferenceImage(taskId, item);
  const [zoom, setZoom] = useState(false);
  const [open, setOpen] = useState(false);
  const notesId = useId();
  const src = img.data ? `data:${img.data.mime};base64,${img.data.data}` : null;
  const title = item.name;
  const summary = referenceSummary(item);
  return (
    <li className="flex w-full max-w-[460px] flex-col gap-2 rounded-xl border border-border bg-panel p-2.5">
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={() => setZoom(true)}
          disabled={!src}
          aria-label={`Show ${item.kind === "link" ? "the screenshot of" : ""} ${title}`.replace(/\s+/g, " ")}
          className="relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-raised enabled:hover:border-border-strong"
        >
          {src ? (
            <img src={src} alt="" className="size-full object-cover object-top" />
          ) : item.kind === "link" ? (
            <Globe className="size-5 text-subtle" aria-hidden />
          ) : (
            <ImageIcon className="size-5 text-subtle" aria-hidden />
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
            <Palette className="size-3.5 shrink-0 text-accent" aria-hidden />
            <span className="truncate" title={item.url ?? item.name}>
              {title}
            </span>
          </span>
          {item.state === "pending" && (
            <span className="flex items-center gap-1.5 text-[11.5px] text-muted" role="status">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {item.kind === "link"
                ? "Opening the page and reading its look…"
                : "Reading the colours and layout…"}
            </span>
          )}
          {item.state === "failed" && (
            <span className="flex items-start gap-1.5 text-[11.5px] text-danger">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {item.error ?? "Depo could not read this reference."}
            </span>
          )}
          {item.state === "studied" && (
            <span className="text-[11.5px] text-muted">
              {summary || "Colours read"}
              {item.vision ? "" : " · colours only"}
            </span>
          )}
        </div>
      </div>
      {item.state === "studied" && item.palette.length > 0 && <Swatches palette={item.palette} />}
      {item.state === "studied" && (item.notes.length > 0 || item.warnings.length > 0) && (
        <div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={notesId}
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 rounded-sm text-[11.5px] text-muted hover:text-fg"
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
            {item.notes.length ? "What Depo saw" : "Notes"}
          </button>
          <div id={notesId} hidden={!open} className="mt-1 flex flex-col gap-1 pl-4">
            {item.notes.length > 0 && (
              <ul className="list-disc pl-3 text-[11.5px] leading-relaxed text-fg marker:text-subtle">
                {item.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            {item.warnings.map((w) => (
              <p key={w} className="text-[11px] text-subtle">
                {w}
              </p>
            ))}
          </div>
        </div>
      )}
      {src && (
        <Modal open={zoom} onOpenChange={setZoom} title={title} className="w-[min(1100px,calc(100vw-32px))]">
          <img
            src={src}
            alt={item.kind === "link" ? `Screenshot of ${item.url ?? title}` : title}
            className="max-h-[75vh] w-full rounded-lg border border-border object-contain"
          />
        </Modal>
      )}
    </li>
  );
}

/** Under a sent message: each reference with what Depo read from it. */
export function MessageReferences({ taskId, items }: { taskId: string; items: DesignReference[] }) {
  if (!items.length) return null;
  return (
    <ul aria-label="Design references" className="flex w-full flex-col items-end gap-2">
      {items.map((r) => (
        <ReferenceCard key={r.id} taskId={taskId} item={r} />
      ))}
    </ul>
  );
}
