import { useQuery } from "@tanstack/react-query";
import { Palette } from "lucide-react";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const HEX = /^#[0-9a-fA-F]{3,8}$/;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Collect colour tokens from anywhere in the design system, with their dotted names. */
function colorsOf(v: Json, prefix = "", out: { name: string; value: string }[] = []) {
  if (typeof v === "string" && HEX.test(v)) out.push({ name: prefix, value: v });
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) colorsOf(x as Json, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export function DesignPanel() {
  const status = useEngine((s) => s.status);
  const projectId = useUi((s) => s.projectId);
  const board = useQuery({
    queryKey: ["blackboard", projectId],
    queryFn: () => call("blackboard.list", { projectId: projectId ?? "" }),
    enabled: status === "open" && !!projectId,
  });
  const fonts = useQuery({
    queryKey: ["design", "fonts"],
    queryFn: () => call("design.fonts", {}),
    enabled: status === "open",
  });
  const scores = useQuery({
    queryKey: ["scores", projectId],
    queryFn: () => call("scores.get", { projectId: projectId ?? "" }),
    enabled: status === "open" && !!projectId,
  });
  const entry = board.data?.entries.find((e) => e.section === "design-system.json");
  let system: Json | null = null;
  let parseError = false;
  if (entry) {
    try {
      system = JSON.parse(entry.content) as Json;
    } catch {
      parseError = true;
    }
  }
  const colors = system ? colorsOf(system) : [];
  const typo = system && typeof system === "object" && !Array.isArray(system) ? system.typography : undefined;
  const specs = (board.data?.entries ?? []).filter((e) => e.section.startsWith("ui-specs/"));
  const ux = scores.data?.ux;

  return (
    <section className="h-full overflow-y-auto" tabIndex={0} aria-label="Design">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6">
        <header className="flex items-center gap-3">
          <Palette className="size-5 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold text-fg">Design</h1>
          {ux && (
            <span
              className={`ml-auto rounded-full border px-2.5 py-0.5 text-xs ${ux.blocksRelease ? "border-danger/50 text-danger" : "border-success/50 text-success"}`}
              data-testid="ux-score"
            >
              UX score {ux.overall}/100 ({ux.grade}){ux.blocksRelease ? " · blocks release" : ""}
            </span>
          )}
        </header>

        <section aria-labelledby="ds-title">
          <h2 id="ds-title" className="mb-2 text-sm font-semibold text-fg">
            Design system
          </h2>
          {!projectId && <p className="text-[13px] text-muted">Open a project to see its design system.</p>}
          {projectId && !entry && (
            <p className="text-[13px] leading-relaxed text-muted">
              No design system yet. In a Full system or Frontend only task, the UI/UX Design agent writes the
              tokens (colors, type scale, spacing, components) and they appear here.
            </p>
          )}
          {parseError && (
            <p className="text-xs text-danger">
              design-system.json is not valid JSON. Ask the UI/UX agent to fix it.
            </p>
          )}
          {colors.length > 0 && (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Colors">
              {colors.slice(0, 32).map((c) => (
                <li key={c.name} className="rounded-lg border border-border bg-panel p-2 text-xs">
                  <span
                    className="block h-8 rounded-md border border-border"
                    style={{ background: c.value }}
                    aria-hidden
                  />
                  <span className="mt-1 block truncate text-fg">{c.name}</span>
                  <span className="font-mono text-subtle">{c.value}</span>
                </li>
              ))}
            </ul>
          )}
          {typo !== undefined && (
            <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-border bg-panel p-3 font-mono text-xs text-muted">
              {JSON.stringify(typo, null, 2)}
            </pre>
          )}
          {specs.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Page specifications: {specs.map((s) => s.section.replace("ui-specs/", "")).join(", ")}
            </p>
          )}
        </section>

        <section aria-labelledby="fonts-title">
          <h2 id="fonts-title" className="mb-1 text-sm font-semibold text-fg">
            Font library
          </h2>
          <p className="mb-2 text-xs text-muted">
            Open-licence fonts that agents choose from. Generated projects self-host them (for example with
            <code className="mx-1 rounded bg-hover px-1">npm i @fontsource/inter</code>), so no font is loaded
            from the internet.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-panel text-subtle">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Family</th>
                  <th className="px-3 py-1.5 font-medium">Type</th>
                  <th className="px-3 py-1.5 font-medium">Scripts</th>
                  <th className="px-3 py-1.5 font-medium">License</th>
                  <th className="px-3 py-1.5 font-medium">Package</th>
                </tr>
              </thead>
              <tbody>
                {(fonts.data?.fonts ?? []).map((f) => (
                  <tr key={f.family} className="border-t border-border/60">
                    <td className="px-3 py-1.5 text-fg">{f.family}</td>
                    <td className="px-3 py-1.5 text-muted">{f.category}</td>
                    <td className="px-3 py-1.5 text-muted">{f.scripts.join(", ")}</td>
                    <td className="px-3 py-1.5 text-muted">{f.license}</td>
                    <td className="px-3 py-1.5 font-mono text-subtle">{f.fontsource}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}
