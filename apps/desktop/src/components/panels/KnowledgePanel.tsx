import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Download, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";

const ECOSYSTEMS = ["npm", "PyPI", "crates.io", "Go", "Maven", "NuGet", "RubyGems", "Packagist", "Pub"];

export function KnowledgePanel() {
  const status = useEngine((s) => s.status);
  const qc = useQueryClient();
  const enabled = status === "open";
  const packs = useQuery({ queryKey: ["knowledge"], queryFn: () => call("knowledge.list", {}), enabled });
  const catalog = useQuery({
    queryKey: ["knowledge", "catalog"],
    queryFn: () => call("knowledge.catalog", {}),
    enabled,
  });
  const osv = useQuery({ queryKey: ["osv"], queryFn: () => call("osv.status", {}), enabled });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["knowledge"] });
    void qc.invalidateQueries({ queryKey: ["osv"] });
  };

  const install = useMutation({
    mutationFn: (id: string) => call("knowledge.install", { id }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => call("knowledge.setEnabled", v),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => call("knowledge.remove", { id }),
    onSuccess: refresh,
  });

  const [imp, setImp] = useState({ name: "", path: "", version: "" });
  const importPack = useMutation({
    mutationFn: () =>
      call("knowledge.import", {
        name: imp.name.trim(),
        path: imp.path.trim(),
        ...(imp.version.trim() ? { version: imp.version.trim() } : {}),
      }),
    onSuccess: () => {
      setImp({ name: "", path: "", version: "" });
      refresh();
    },
  });

  const [query, setQuery] = useState("");
  const search = useMutation({ mutationFn: () => call("knowledge.search", { query: query.trim() }) });

  const [eco, setEco] = useState("npm");
  const [zip, setZip] = useState("");
  const osvImport = useMutation({
    mutationFn: () => call("osv.import", { ecosystem: eco, ...(zip.trim() ? { zipPath: zip.trim() } : {}) }),
    onSuccess: refresh,
  });

  return (
    <section className="h-full overflow-y-auto" tabIndex={0} aria-label="Knowledge">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6">
        <header className="flex items-center gap-3">
          <BookOpen className="size-5 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold text-fg">Knowledge</h1>
        </header>
        <p className="-mt-3 text-[13px] leading-relaxed text-muted">
          Packs are local documents that agents search while they work, so they use current references offline
          and name the pack and version they used. Downloading a pack happens only when you press Install.
        </p>

        <section aria-labelledby="packs">
          <h2 id="packs" className="mb-2 text-sm font-semibold text-fg">
            Installed packs
          </h2>
          {(packs.data?.packs ?? []).length === 0 && <p className="text-[13px] text-muted">No packs yet.</p>}
          <ul className="flex flex-col gap-2">
            {(packs.data?.packs ?? []).map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">
                    {p.name} <span className="font-normal text-subtle">{p.version}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {p.docCount} documents · {p.chunkCount} passages · {p.kind}
                    {p.description ? ` · ${p.description}` : ""}
                  </div>
                </div>
                <label className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => toggle.mutate({ id: p.id, enabled: e.target.checked })}
                  />
                  Agents can search it
                </label>
                <Button
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Remove "${p.name}"?`)) remove.mutate(p.id);
                  }}
                >
                  <Trash2 aria-hidden /> Remove
                </Button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="search">
          <h2 id="search" className="mb-2 text-sm font-semibold text-fg">
            Search the packs
          </h2>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim().length > 1) search.mutate();
            }}
          >
            <input
              aria-label="Search the knowledge packs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. prevent SQL injection"
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-accent"
            />
            <Button type="submit" disabled={query.trim().length < 2 || search.isPending}>
              <Search aria-hidden /> Search
            </Button>
          </form>
          <ul className="mt-2 flex flex-col gap-2">
            {(search.data?.hits ?? []).map((h) => (
              <li
                key={`${h.pack}-${h.path}-${h.title}`}
                className="rounded-lg border border-border bg-panel p-3"
              >
                <div className="text-xs text-subtle">
                  {h.pack} {h.version} · {h.path}
                </div>
                <div className="text-[13px] font-medium text-fg">{h.title}</div>
                <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-muted">{h.snippet}</p>
              </li>
            ))}
            {search.data && search.data.hits.length === 0 && (
              <li className="text-[13px] text-muted">Nothing found.</li>
            )}
          </ul>
        </section>

        <section aria-labelledby="cat">
          <h2 id="cat" className="mb-1 text-sm font-semibold text-fg">
            Available packs
          </h2>
          <p className="mb-2 text-xs text-muted">
            These come from public GitHub repositories. The addresses were not checked from the build machine;
            if one has moved, the install says so and you can import the folder yourself below.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {(catalog.data?.entries ?? []).map((c) => (
              <li key={c.id} className="flex flex-col gap-1 rounded-lg border border-border bg-panel p-3">
                <div className="text-[13px] font-medium text-fg">{c.name}</div>
                <div className="text-xs text-muted">{c.description}</div>
                <div className="mt-auto flex items-center gap-2 pt-1 text-[11px] text-subtle">
                  <span>about {c.approxSizeMb} MB</span>
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={c.installed || install.isPending}
                    onClick={() => install.mutate(c.id)}
                  >
                    <Download aria-hidden />{" "}
                    {c.installed
                      ? "Installed"
                      : install.isPending && install.variables === c.id
                        ? "Installing…"
                        : "Install"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {install.isError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {(install.error as Error).message}
            </p>
          )}
        </section>

        <section aria-labelledby="own" className="rounded-lg border border-border bg-panel p-4">
          <h2 id="own" className="text-sm font-semibold text-fg">
            Add your own
          </h2>
          <p className="mt-1 text-xs text-muted">
            Point at a folder or a file of Markdown, text, HTML (a website export) or PDF.
          </p>
          <form
            className="mt-3 grid gap-2 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              importPack.mutate();
            }}
          >
            <input
              aria-label="Pack name"
              placeholder="Pack name"
              value={imp.name}
              onChange={(e) => setImp({ ...imp, name: e.target.value })}
              className="h-9 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
            />
            <input
              aria-label="Folder or file path"
              placeholder="C:\docs\handbook"
              value={imp.path}
              onChange={(e) => setImp({ ...imp, path: e.target.value })}
              className="h-9 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-fg"
            />
            <input
              aria-label="Version"
              placeholder="Version (optional)"
              value={imp.version}
              onChange={(e) => setImp({ ...imp, version: e.target.value })}
              className="h-9 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
            />
            <div className="sm:col-span-3">
              <Button
                type="submit"
                variant="primary"
                disabled={!imp.name.trim() || !imp.path.trim() || importPack.isPending}
              >
                {importPack.isPending ? "Indexing…" : "Index it"}
              </Button>
            </div>
          </form>
          {importPack.isError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {(importPack.error as Error).message}
            </p>
          )}
        </section>

        <section aria-labelledby="osv" className="rounded-lg border border-border bg-panel p-4">
          <h2 id="osv" className="text-sm font-semibold text-fg">
            Offline vulnerability database (OSV)
          </h2>
          <p className="mt-1 text-xs text-muted">
            The Security agent checks your dependencies against this local copy, with no network. Download one
            ecosystem at a time from osv.dev, or choose an <code>all.zip</code> you already have.
          </p>
          <ul className="mt-2 text-xs text-muted">
            {(osv.data?.status ?? []).map((s) => (
              <li key={s.ecosystem}>
                {s.ecosystem}: {s.count} entries, imported {new Date(s.importedAt).toLocaleDateString()}
              </li>
            ))}
            {(osv.data?.status ?? []).length === 0 && <li>Nothing imported yet.</li>}
          </ul>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              osvImport.mutate();
            }}
          >
            <select
              aria-label="Ecosystem"
              value={eco}
              onChange={(e) => setEco(e.target.value)}
              className="h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
            >
              {ECOSYSTEMS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input
              aria-label="Path of an all.zip (optional)"
              placeholder="Path of an all.zip (optional)"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-fg"
            />
            <Button type="submit" disabled={osvImport.isPending}>
              {osvImport.isPending ? "Importing…" : zip.trim() ? "Import file" : "Download"}
            </Button>
          </form>
          {osvImport.isError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {(osvImport.error as Error).message}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
