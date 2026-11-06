import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FilePlus2, Network, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const TEMPLATES: Record<string, string> = {
  Flowchart: "flowchart LR\n  Browser[Web app] --> API[API server]\n  API --> DB[(Database)]\n",
  "ER diagram":
    "erDiagram\n  USER ||--o{ TODO : owns\n  USER {\n    int id PK\n    string email UK\n  }\n  TODO {\n    int id PK\n    int user_id FK\n    string title\n  }\n",
  Sequence:
    "sequenceDiagram\n  participant U as User\n  participant A as API\n  U->>A: Log in\n  A-->>U: Token\n",
  State: "stateDiagram-v2\n  [*] --> Open\n  Open --> Done: complete\n  Done --> [*]\n",
};

/** A .md diagram file keeps its Mermaid in a fenced block. */
function mermaidSource(content: string): string {
  const m = /```mermaid\s*\n([\s\S]*?)```/.exec(content);
  return m?.[1] ?? content;
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidReady ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: document.documentElement.dataset.theme === "light" ? "default" : "dark",
    });
    return m.default;
  });
  return mermaidReady;
}

export function DiagramsPanel() {
  const status = useEngine((s) => s.status);
  const projectId = useUi((s) => s.projectId);
  const taskId = useUi((s) => s.taskId);
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["diagrams", projectId, taskId],
    queryFn: () => call("diagrams.list", { projectId: projectId ?? "", ...(taskId ? { taskId } : {}) }),
    enabled: status === "open" && !!projectId,
  });
  const diagrams = list.data?.diagrams ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const current = diagrams.find((d) => d.path === selected) ?? null;

  // Load the file into the editor when another diagram is picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the selection changes
  useEffect(() => {
    if (current) setDraft(current.content);
  }, [current?.path]);
  useEffect(() => {
    if (!selected && diagrams[0]) setSelected(diagrams[0].path);
  }, [selected, diagrams]);

  const save = useMutation({
    mutationFn: (v: { path: string; content: string }) =>
      call("diagrams.save", { projectId: projectId ?? "", path: v.path, content: v.content }),
    onSuccess: (r) => {
      setSelected(r.path);
      setNewName(null);
      void qc.invalidateQueries({ queryKey: ["diagrams"] });
    },
  });

  if (!projectId) {
    return <Empty text="Open a project to see its diagrams." />;
  }
  const dirty = current ? draft !== current.content : draft.trim().length > 0;
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Diagrams" className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
        <div className="flex gap-1 p-2">
          <select
            aria-label="New diagram from template"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-1.5 text-xs text-muted"
            value=""
            onChange={(e) => {
              const t = TEMPLATES[e.target.value];
              if (t) {
                setSelected(null);
                setNewName(`docs/diagrams/${e.target.value.toLowerCase().replace(/[^a-z]+/g, "-")}.mmd`);
                setDraft(t);
              }
            }}
          >
            <option value="">New diagram…</option>
            {Object.keys(TEMPLATES).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {diagrams.map((d) => (
            <li key={d.path}>
              <button
                type="button"
                onClick={() => {
                  setSelected(d.path);
                  setNewName(null);
                }}
                aria-current={d.path === selected ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover",
                  d.path === selected && "bg-hover",
                )}
              >
                <span className="truncate text-fg">{d.path.split("/").pop()}</span>
                <span className="text-[11px] text-subtle">
                  {d.source === "workspace" ? "In the task copy, not applied yet" : "In the project"}
                </span>
              </button>
            </li>
          ))}
          {diagrams.length === 0 && !newName && (
            <li className="px-2 py-1 text-xs text-subtle">
              No diagrams yet. The Diagram agent writes them to docs/diagrams, or start one from a template.
            </li>
          )}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {newName ?? current?.path ?? "Diagrams"}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty || save.isPending || !(newName ?? current?.path)}
            onClick={() => save.mutate({ path: newName ?? current?.path ?? "", content: draft })}
          >
            <Save aria-hidden /> Save to project
          </Button>
        </div>
        {save.isError && <p className="px-4 pt-2 text-xs text-danger">{(save.error as Error).message}</p>}
        <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-2">
          <div className="flex min-h-0 flex-col border-b border-border md:border-r md:border-b-0">
            <label
              htmlFor="diagram-source"
              className="px-4 pt-2 text-[11px] uppercase tracking-wide text-subtle"
            >
              Mermaid source
            </label>
            <textarea
              id="diagram-source"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-transparent px-4 py-2 font-mono text-xs text-fg outline-none"
            />
          </div>
          <Preview
            source={mermaidSource(draft)}
            name={(newName ?? current?.path ?? "diagram").split("/").pop() ?? "diagram"}
          />
        </div>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
      <Network className="size-8 text-subtle" aria-hidden />
      <p className="text-[13px] text-muted">{text}</p>
    </div>
  );
}

function Preview({ source, name }: { source: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState("");
  const id = useMemo(() => `m${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    if (!source.trim()) {
      setSvg("");
      setError(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      loadMermaid()
        .then(async (m) => {
          try {
            await m.parse(source);
            const out = await m.render(id, source);
            if (!cancelled) {
              setSvg(out.svg);
              setError(null);
            }
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [source, id]);

  const base = name.replace(/\.[^.]+$/, "");
  const download = (blob: Blob, file: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const dataUrl = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : "";
  const exportPng = () => {
    const el = host.current?.querySelector("img");
    if (!el || !el.naturalWidth) return;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = document.documentElement.dataset.theme === "light" ? "#ffffff" : "#0b1020";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => blob && download(blob, `${base}.png`));
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pt-2">
        <span className="flex-1 text-[11px] uppercase tracking-wide text-subtle">Preview</span>
        <Button
          size="sm"
          disabled={!svg}
          onClick={() => download(new Blob([svg], { type: "image/svg+xml" }), `${base}.svg`)}
        >
          <Download aria-hidden /> SVG
        </Button>
        <Button size="sm" disabled={!svg} onClick={exportPng}>
          <FilePlus2 aria-hidden /> PNG
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="mx-4 mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg"
        >
          {error.slice(0, 600)}
        </p>
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-auto p-4">
        {/* An <img> never runs scripts, so the diagram is shown safely even if its source is untrusted. */}
        {dataUrl && <img alt="Diagram preview" src={dataUrl} className="mx-auto h-auto max-w-full" />}
      </div>
    </div>
  );
}
