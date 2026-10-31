import type { Project } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderSearch, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, inputClass, Modal } from "@/components/ui/modal";
import { isTauri } from "@/lib/connection";
import { call } from "@/lib/engine";
import {
  afterProjectAdded,
  defaultParentDir,
  pickFolder,
  rememberParentDir,
  selectProject,
} from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { useUi } from "@/store/ui";

/** All project dialogs, driven by `useUi().projectDialog`. */
export function ProjectDialogs() {
  const dialog = useUi((s) => s.projectDialog);
  const setDialog = useUi((s) => s.setProjectDialog);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  return (
    <>
      <NewProjectDialog open={dialog?.kind === "new"} onOpenChange={close} />
      <ImportProjectDialog open={dialog?.kind === "import"} onOpenChange={close} />
      <RenameProjectDialog
        projectId={dialog?.kind === "rename" ? dialog.projectId : null}
        onOpenChange={close}
      />
      <RemoveProjectDialog
        projectId={dialog?.kind === "remove" ? dialog.projectId : null}
        onOpenChange={close}
      />
    </>
  );
}

function useProject(id: string | null): Project | undefined {
  const list = useQuery({
    queryKey: ["projects"],
    queryFn: () => call("projects.list", { includeArchived: true }),
    enabled: !!id,
  });
  return list.data?.projects.find((p) => p.id === id);
}

function FolderInput({
  id,
  value,
  onChange,
  title,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  title: string;
}) {
  return (
    <div className="flex gap-1.5">
      <input
        id={id}
        aria-label={title}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"C:\\Users\\you\\code"}
        className={`${inputClass} font-mono text-[11px]`}
      />
      {isTauri() && (
        <Button
          size="sm"
          aria-label="Browse for a folder"
          onClick={async () => {
            const picked = await pickFolder(title);
            if (picked) onChange(picked);
          }}
        >
          <FolderSearch aria-hidden /> Browse
        </Button>
      )}
    </div>
  );
}

function useDefaultParent(open: boolean, set: (v: string) => void) {
  useEffect(() => {
    if (!open) return;
    let live = true;
    void defaultParentDir().then((d) => {
      if (live && d) set(d);
    });
    return () => {
      live = false;
    };
  }, [open, set]);
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [description, setDescription] = useState("");
  const [stack, setStack] = useState("");
  const [initGit, setInitGit] = useState(true);
  useDefaultParent(open, setParentDir);
  const create = useMutation({
    mutationFn: () =>
      call("projects.create", {
        name: name.trim(),
        parentDir: parentDir.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(stack.trim() ? { stack: stack.trim() } : {}),
        initGit,
      }),
    onSuccess: async (p) => {
      rememberParentDir(parentDir.trim());
      await afterProjectAdded(p);
      useUi.getState().setCenterTab("overview");
      onOpenChange(false);
      setName("");
      setDescription("");
      setStack("");
    },
  });
  const sep = parentDir.includes("/") && !parentDir.includes("\\") ? "/" : "\\";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && parentDir.trim()) create.mutate();
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Depo makes a new folder with a README and an empty git repository, then opens it."
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-app"
            className={inputClass}
            maxLength={80}
            required
          />
        </Field>
        <Field
          label="Create in"
          hint={
            name.trim() && parentDir.trim() ? (
              <>
                The project folder will be{" "}
                <span className="font-mono">
                  {parentDir.trim().replace(/[\\/]+$/, "")}
                  {sep}
                  {name.trim()}
                </span>
              </>
            ) : undefined
          }
        >
          <FolderInput
            id="new-parent"
            value={parentDir}
            onChange={setParentDir}
            title="Folder to create the project in"
          />
        </Field>
        <Field label="What is it?" hint="Optional. Agents read this from the project memory.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="A REST API for a small online shop"
            className={`${inputClass} field-in-frame h-auto py-1.5`}
          />
        </Field>
        <Field label="Stack" hint="Optional, for example: Python, FastAPI, PostgreSQL">
          <input value={stack} onChange={(e) => setStack(e.target.value)} className={inputClass} />
        </Field>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
          Start a git repository
        </label>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || !name.trim() || !parentDir.trim()}
          >
            {create.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const GIT_URL = /^(https?|ssh|git):\/\/\S+$|^[\w.-]+@[\w.-]+:\S+$/i;

function ImportProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [source, setSource] = useState("");
  const [parentDir, setParentDir] = useState("");
  useDefaultParent(open, setParentDir);
  const isUrl = GIT_URL.test(source.trim());
  const imp = useMutation({
    mutationFn: () =>
      call(
        "projects.import",
        { source: source.trim(), ...(isUrl ? { parentDir: parentDir.trim() } : {}) },
        { timeoutMs: 16 * 60_000 },
      ),
    onSuccess: async (p) => {
      if (isUrl) rememberParentDir(parentDir.trim());
      await afterProjectAdded(p);
      useUi.getState().setCenterTab("overview");
      onOpenChange(false);
      setSource("");
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import a project"
      description="Add a folder that is already on this PC, or clone a git repository. Depo never changes your files without your approval."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim()) imp.mutate();
        }}
      >
        <Field
          label="Folder or git URL"
          hint="For example C:\code\my-app, or https://github.com/owner/repo.git"
        >
          <div className="flex gap-1.5">
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={"C:\\code\\my-app or https://…"}
              className={`${inputClass} font-mono text-[11px]`}
              required
            />
            {isTauri() && (
              <Button
                size="sm"
                aria-label="Browse for a project folder"
                onClick={async () => {
                  const picked = await pickFolder("Choose a project folder");
                  if (picked) setSource(picked);
                }}
              >
                <FolderSearch aria-hidden /> Browse
              </Button>
            )}
          </div>
        </Field>
        {isUrl && (
          <Field label="Clone into" hint="A new folder named after the repository is made here.">
            <FolderInput
              id="clone-parent"
              value={parentDir}
              onChange={setParentDir}
              title="Folder to clone into"
            />
          </Field>
        )}
        <ErrorText error={imp.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={imp.isPending || !source.trim() || (isUrl && !parentDir.trim())}
          >
            {imp.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {isUrl ? (imp.isPending ? "Cloning…" : "Clone and import") : "Import"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameProjectDialog({
  projectId,
  onOpenChange,
}: {
  projectId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const project = useProject(projectId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stack, setStack] = useState("");
  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description);
      setStack(project.stack);
    }
  }, [project]);
  const save = useMutation({
    mutationFn: () => call("projects.update", { id: projectId ?? "", name: name.trim(), description, stack }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      onOpenChange(false);
    },
  });
  return (
    <Modal
      open={!!projectId}
      onOpenChange={onOpenChange}
      title="Edit project details"
      description="The name is only used inside Depo; the folder keeps its name."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            maxLength={80}
            required
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={`${inputClass} field-in-frame h-auto py-1.5`}
          />
        </Field>
        <Field label="Stack">
          <input value={stack} onChange={(e) => setStack(e.target.value)} className={inputClass} />
        </Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={save.isPending || !name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveProjectDialog({
  projectId,
  onOpenChange,
}: {
  projectId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const project = useProject(projectId);
  const remove = useMutation({
    mutationFn: () => call("projects.delete", { id: projectId ?? "" }),
    onSuccess: async () => {
      if (useUi.getState().projectId === projectId) selectProject(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
    },
  });
  return (
    <Modal
      open={!!projectId}
      onOpenChange={onOpenChange}
      title={`Remove ${project?.name ?? "project"} from Depo?`}
      description={
        <>
          Depo forgets this project: its tasks, change history, memory and index. The folder{" "}
          <span className="font-mono">{project?.rootPath}</span> and every file in it stay where they are.
        </>
      }
    >
      <ErrorText error={remove.error} />
      <div className="mt-2 flex justify-end gap-2">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button
          className="bg-danger text-white hover:opacity-90"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove from Depo
        </Button>
      </div>
    </Modal>
  );
}
