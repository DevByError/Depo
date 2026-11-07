import type { DevDbInfo } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Database } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { copyText } from "@/lib/open-url";
import { useEngine } from "@/store/engine";
import { Card } from "./parts";

const STATE_LABEL: Record<DevDbInfo["state"], string> = {
  missing: "not installed",
  stopped: "stopped",
  starting: "starting",
  running: "running",
  failed: "could not start",
};

/**
 * The project's test database: MariaDB that Depo runs on this PC so the app can be tried with
 * demo data before the owner sets up a database of their own. Agents start it when the app needs
 * MySQL; the owner can start, stop or empty it here and copy the connection details.
 */
export function TestDatabaseCard({ projectId }: { projectId: string }) {
  const enabled = useEngine((s) => s.status === "open");
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const key = ["devdb", projectId];
  const status = useQuery({
    queryKey: key,
    queryFn: () => call("devdb.status", { projectId }),
    enabled,
    refetchInterval: (q) => (q.state.data?.state === "starting" ? 1500 : 15_000),
  });
  const act = useMutation({
    mutationFn: async (what: "start" | "stop" | "reset") => {
      if (what === "stop") await call("devdb.stop", { projectId });
      else await call(what === "start" ? "devdb.start" : "devdb.reset", { projectId });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const db = status.data;
  const running = db?.state === "running";
  const busy = act.isPending || db?.state === "starting";
  return (
    <Card title="Test database" icon={Database}>
      {!db ? (
        <p className="text-xs text-subtle">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2 text-xs">
          <p className="flex items-center gap-2 text-fg">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                running ? "bg-success" : db.state === "failed" ? "bg-danger" : "bg-border-strong",
                db.state === "starting" && "bg-warning motion-safe:animate-pulse",
              )}
              aria-hidden
            />
            <span>
              {db.engine === "mysql" ? "MySQL" : "MariaDB"}
              {db.version ? ` ${db.version}` : ""} · {STATE_LABEL[db.state]}
              {running && db.port ? ` on 127.0.0.1:${db.port}` : ""}
            </span>
          </p>
          {db.database ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
              <dt className="text-subtle">database</dt>
              <dd className="truncate text-fg">{db.database}</dd>
              <dt className="text-subtle">user</dt>
              <dd className="truncate text-fg">{db.user}</dd>
              <dt className="text-subtle">password</dt>
              <dd className="truncate text-fg">{db.password}</dd>
            </dl>
          ) : (
            <p className="text-subtle">
              {db.state === "missing"
                ? "No MySQL or MariaDB is installed on this PC. Install MariaDB, then start it here."
                : "Agents create it when your app needs MySQL, with tables and demo data. It only listens on this PC."}
            </p>
          )}
          {db.state === "failed" && db.message && <p className="text-danger">{db.message}</p>}
          <div className="flex flex-wrap gap-1.5">
            {running ? (
              <>
                <Button size="sm" onClick={() => act.mutate("stop")} disabled={busy}>
                  Stop
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Empty ${db.database}? Every table and row is deleted.`))
                      act.mutate("reset");
                  }}
                  disabled={busy}
                >
                  Empty it
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => act.mutate("start")} disabled={busy || db.state === "missing"}>
                {db.state === "starting" || act.isPending
                  ? "Starting…"
                  : db.database
                    ? "Start"
                    : "Create and start"}
              </Button>
            )}
            {db.url && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  setCopied(await copyText(db.url ?? ""));
                  setTimeout(() => setCopied(false), 1500);
                }}
                aria-label="Copy the connection address (DATABASE_URL)"
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy DATABASE_URL"}
              </Button>
            )}
          </div>
        </div>
      )}
      <ErrorText error={act.error ?? status.error} />
    </Card>
  );
}
