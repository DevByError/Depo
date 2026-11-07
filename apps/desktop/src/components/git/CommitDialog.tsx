import type { ApiResult, GitDraft, GitDraftFile } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileMinus,
  FilePlus,
  FileText,
  GitBranch,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, inputClass, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const KIND_ICON = { added: FilePlus, modified: FileText, deleted: FileMinus } as const;
const KIND_TONE = { added: "text-success", modified: "text-info", deleted: "text-danger" } as const;

type Committed = ApiResult<"git.commit">;

/**
 * Commit the files Depo applied: a drafted conventional message the owner can edit, the files
 * to include, and where to commit (the current branch or a new `depo/…` branch). Never pushes.
 */
export function CommitDialog({
  projectId,
  changeSetId,
  open,
  onOpenChange,
}: {
  projectId: string;
  changeSetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [done, setDone] = useState<Committed | null>(null);
  // A fresh form each time it opens.
  useEffect(() => {
    if (open) setDone(null);
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={done ? "Committed" : "Commit these changes"}
      description={
        done
          ? undefined
          : "Only the files Depo applied are committed. Your other changes stay as they are, and nothing is pushed."
      }
      className="w-[min(640px,calc(100vw-32px))]"
    >
      {open &&
        (done ? (
          <CommitResult result={done} onClose={() => onOpenChange(false)} />
        ) : (
          <CommitForm
            projectId={projectId}
            changeSetId={changeSetId}
            onDone={setDone}
            onCancel={() => onOpenChange(false)}
          />
        ))}
    </Modal>
  );
}

function CommitForm({
  projectId,
  changeSetId,
  onDone,
  onCancel,
}: {
  projectId: string;
  changeSetId: string;
  onDone: (r: Committed) => void;
  onCancel: () => void;
}) {
  const connected = useEngine((s) => s.status === "open");
  const qc = useQueryClient();
  const ids = useId();
  // Depo's template comes at once; the local model's draft follows in the background.
  const template = useQuery({
    queryKey: ["git", "draft", projectId, changeSetId, "template"],
    queryFn: () => call("git.draftCommit", { projectId, changeSetId, model: false }, { timeoutMs: 30_000 }),
    enabled: connected,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const drafted = useQuery({
    queryKey: ["git", "draft", projectId, changeSetId, "model"],
    queryFn: () => call("git.draftCommit", { projectId, changeSetId, model: true }, { timeoutMs: 110_000 }),
    enabled:
      connected && !!template.data && template.data.files.some((f) => f.include) && !!template.data.identity,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

  const [message, setMessage] = useState("");
  const [base, setBase] = useState<string | null>(null);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [where, setWhere] = useState<"current" | "branch">("current");
  const [branch, setBranch] = useState("");
  const seeded = useRef(false);

  const draft: GitDraft | undefined = template.data;
  useEffect(() => {
    if (!draft || seeded.current) return;
    seeded.current = true;
    setMessage(draft.message);
    setBase(draft.message);
    setInclude(new Set(draft.files.filter((f) => f.include).map((f) => f.path)));
    setBranch(draft.suggestedBranch);
    if (!draft.branch) setWhere("branch");
  }, [draft]);

  // Take the model's draft when the owner has not started editing the message.
  const modelDraft = drafted.data?.source === "model" ? drafted.data.message : null;
  const edited = base !== null && message !== base;
  useEffect(() => {
    if (modelDraft && !edited && message !== modelDraft) {
      setMessage(modelDraft);
      setBase(modelDraft);
    }
  }, [modelDraft, edited, message]);

  const commit = useMutation({
    mutationFn: () =>
      call(
        "git.commit",
        {
          projectId,
          changeSetId,
          message,
          files: [...include],
          ...(where === "branch" ? { branch: branch.trim() } : {}),
        },
        { timeoutMs: 130_000 },
      ),
    onSuccess: (r) => {
      // Not the drafts: refetching them would ask the model again.
      void qc.invalidateQueries({ queryKey: ["git", "status"] });
      void qc.invalidateQueries({ queryKey: ["git", "log"] });
      onDone(r);
    },
  });

  if (template.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> Reading what changed…
      </p>
    );
  }
  if (template.isError || !draft) return <ErrorText error={template.error ?? "The draft could not load."} />;

  const usingModel = modelDraft !== null && message === modelDraft;
  const branchOk = where === "current" || /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch.trim());
  const canCommit =
    !!draft.identity && include.size > 0 && message.trim().length > 0 && branchOk && !commit.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canCommit) commit.mutate();
      }}
    >
      {draft.committed && (
        <p className="flex items-start gap-2 rounded-md border border-border bg-raised/40 px-2.5 py-2 text-xs text-muted">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>
            Already committed as <code className="font-mono text-fg">{draft.committed.shortHash}</code>
            {draft.committed.branch ? ` on ${draft.committed.branch}` : ""}. Files changed since then can
            still be committed.
          </span>
        </p>
      )}

      {!draft.identity && <IdentityForm projectId={projectId} onSaved={() => void template.refetch()} />}

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`${ids}-msg`} className="text-xs font-medium text-fg">
            Commit message
          </label>
          <DraftNote
            usingModel={usingModel}
            pending={drafted.isFetching}
            modelReady={modelDraft !== null && !usingModel}
            note={drafted.data?.note ?? null}
            onUseModel={() => {
              if (modelDraft) {
                setMessage(modelDraft);
                setBase(modelDraft);
              }
            }}
          />
        </div>
        <textarea
          id={`${ids}-msg`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={8}
          spellCheck
          className={cn(inputClass, "h-auto resize-y py-1.5 font-mono text-[12px] leading-relaxed")}
        />
        <p className="text-[11px] text-subtle">
          First line: type(scope): what changed. Then a blank line and why.
        </p>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-fg">
          Files to commit{" "}
          <span className="font-normal text-muted">
            ({include.size} of {draft.files.length})
          </span>
        </legend>
        <ul className="max-h-44 overflow-y-auto rounded-md border border-border">
          {draft.files.map((f) => (
            <FileChoice
              key={f.path}
              f={f}
              checked={include.has(f.path)}
              onChange={(on) => {
                const next = new Set(include);
                if (on) next.add(f.path);
                else next.delete(f.path);
                setInclude(next);
              }}
            />
          ))}
        </ul>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-fg">Where</legend>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="radio"
            name={`${ids}-where`}
            checked={where === "current"}
            disabled={!draft.branch}
            onChange={() => setWhere("current")}
          />
          {draft.branch ? (
            <span>
              The current branch, <span className="font-mono">{draft.branch}</span>
            </span>
          ) : (
            <span className="text-muted">The current branch (you are not on a branch right now)</span>
          )}
        </label>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="radio"
            name={`${ids}-where`}
            checked={where === "branch"}
            onChange={() => setWhere("branch")}
          />
          <span className="shrink-0">A new branch</span>
          <span className="sr-only">named</span>
          <input
            aria-label="New branch name"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setWhere("branch");
            }}
            className={cn(inputClass, "h-7 min-w-0 flex-1 font-mono", !branchOk && "border-danger")}
          />
        </label>
        {!branchOk && (
          <p className="text-[11px] text-danger">
            Use letters, digits, dots, dashes, underscores and slashes.
          </p>
        )}
      </fieldset>

      <ErrorText error={commit.error} />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!canCommit}>
          {commit.isPending ? (
            <Loader2 className="motion-safe:animate-spin" aria-hidden />
          ) : (
            <GitBranch aria-hidden />
          )}
          Commit {include.size} file{include.size === 1 ? "" : "s"}
        </Button>
      </div>
    </form>
  );
}

function DraftNote({
  usingModel,
  pending,
  modelReady,
  note,
  onUseModel,
}: {
  usingModel: boolean;
  pending: boolean;
  modelReady: boolean;
  note: string | null;
  onUseModel: () => void;
}) {
  if (pending)
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted" role="status">
        <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
        Your local model is writing a draft…
      </span>
    );
  if (usingModel)
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted" role="status">
        <Sparkles className="size-3 text-accent" aria-hidden />
        Drafted by your local model
      </span>
    );
  if (modelReady)
    return (
      <button type="button" onClick={onUseModel} className="text-[11px] text-accent hover:underline">
        Use your model's draft instead
      </button>
    );
  return <span className="text-[11px] text-muted">{note ?? "Drafted by Depo"}</span>;
}

function FileChoice({
  f,
  checked,
  onChange,
}: {
  f: GitDraftFile;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const Icon = KIND_ICON[f.kind];
  return (
    <li className="border-b border-border px-2.5 py-1.5 last:border-b-0">
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <Icon className={cn("size-3.5 shrink-0", KIND_TONE[f.kind])} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-fg" title={f.path}>
          {f.path}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums">
          <span className="text-success">+{f.additions}</span>{" "}
          <span className="text-danger">−{f.deletions}</span>
        </span>
      </label>
      {f.note && (
        <p className="mt-0.5 ml-6 flex items-start gap-1 text-[11px] text-warning">
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          {f.note}
        </p>
      )}
    </li>
  );
}

function IdentityForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const ids = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const save = useMutation({
    mutationFn: () => call("git.setIdentity", { projectId, name: name.trim(), email: email.trim() }),
    onSuccess: onSaved,
  });
  return (
    <fieldset className="rounded-md border border-border bg-raised/40 p-3" aria-describedby={`${ids}-why`}>
      <legend className="float-left w-full text-xs font-medium text-fg">
        Git does not know who you are yet
      </legend>
      <p id={`${ids}-why`} className="clear-left pt-0.5 text-[11px] text-muted">
        Commits carry a name and email. Add them for this project only; your other repositories stay as they
        are.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex min-w-36 flex-1 flex-col gap-1 text-[11px] text-muted">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            autoComplete="name"
          />
        </label>
        <label className="flex min-w-44 flex-1 flex-col gap-1 text-[11px] text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            autoComplete="email"
          />
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!name.trim() || !email.includes("@") || save.isPending}
          onClick={() => save.mutate()}
        >
          Save for this project
        </Button>
      </div>
      <div className="mt-1.5">
        <ErrorText error={save.error} />
      </div>
    </fieldset>
  );
}

function CommitResult({ result, onClose }: { result: Committed; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 text-[13px] text-fg" role="status">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        <span>
          Committed {result.files.length} file{result.files.length === 1 ? "" : "s"} to{" "}
          <span className="font-mono">{result.branch ?? "a detached HEAD"}</span> as{" "}
          <code className="font-mono">{result.shortHash}</code>.
          {result.createdBranch ? " The branch is new." : ""} Nothing was pushed.
        </span>
      </p>
      {result.skipped.length > 0 && (
        <div className="text-xs text-muted">
          <p>Left out:</p>
          <ul className="mt-1 list-disc pl-5">
            {result.skipped.map((s) => (
              <li key={s.path}>
                <span className="font-mono text-fg">{s.path}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            useUi.getState().setBottomTab("history");
            onClose();
          }}
        >
          Show history
        </Button>
        <Button size="sm" variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
