import type { PendingApprovalDto } from "@depo/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquareText, ShieldAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";

/**
 * A command, install or plan waiting for the owner. Allow and Decline take one click; "Tell Depo
 * why" opens a short reason inline (Enter declines with it, Escape closes it). The agent that asked
 * reads the reason at its next step, a declined plan is planned again with it, and Depo remembers it.
 */
export function ApprovalCard({ approval }: { approval: PendingApprovalDto }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const inputId = useId();
  const whyId = useId();
  const respond = useMutation({
    mutationFn: (v: { approve: boolean; reason?: string; scope?: "once" | "task" | "project" }) =>
      call("approvals.respond", {
        id: approval.id,
        approve: v.approve,
        ...(v.reason ? { reason: v.reason } : {}),
        ...(v.scope ? { scope: v.scope } : {}),
      }),
    onSettled: (_r, _e, v) => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      if (v.scope === "project") void qc.invalidateQueries({ queryKey: ["projectSettings"] });
    },
  });
  const command = approval.details?.command;
  const planText = approval.details?.plan;
  const isPlan = typeof planText === "string";
  // A command can be allowed for longer, like "don't ask again" in a terminal.
  const canWiden = approval.kind === "command" && !isPlan;
  const close = () => {
    setAsking(false);
    setReason("");
    // Back to the button that opened it, so keyboard users keep their place.
    requestAnimationFrame(() => document.getElementById(whyId)?.focus());
  };
  const decline = () => {
    const why = reason.trim();
    respond.mutate({ approve: false, ...(why ? { reason: why } : {}) });
  };

  return (
    <section
      aria-label="Approval needed"
      className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-[13px]"
    >
      <div className="flex items-center gap-2 font-medium text-fg">
        <ShieldAlert className="size-4 text-warning" aria-hidden />
        {approval.title}
      </div>
      <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{approval.reason}</p>
      {isPlan && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-fg">
          {planText}
        </pre>
      )}
      {typeof command === "string" && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs text-fg">
          {command}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ approve: true })}
        >
          <Check aria-hidden /> Allow
        </Button>
        {canWiden && approval.taskId && (
          <Button
            size="sm"
            disabled={respond.isPending}
            title="Allow this and every other command this task asks for"
            onClick={() => respond.mutate({ approve: true, scope: "task" })}
          >
            Allow for this task
          </Button>
        )}
        {canWiden && approval.projectId && (
          <Button
            size="sm"
            disabled={respond.isPending}
            title="Turn on full access: agents install, build and start servers in this project without asking. Blocked commands stay blocked; switch it off in Project settings."
            onClick={() => respond.mutate({ approve: true, scope: "project" })}
          >
            Allow all in this project
          </Button>
        )}
        {!asking && (
          <>
            <Button size="sm" disabled={respond.isPending} onClick={decline}>
              <X aria-hidden /> Decline
            </Button>
            <Button
              id={whyId}
              variant="ghost"
              size="sm"
              disabled={respond.isPending}
              onClick={() => setAsking(true)}
            >
              <MessageSquareText aria-hidden /> Tell Depo why
            </Button>
          </>
        )}
      </div>
      {asking && (
        <form
          aria-label="Decline with a reason"
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            decline();
          }}
        >
          <label htmlFor={inputId} className="basis-full text-xs text-muted">
            {isPlan
              ? "What should change? The Manager plans again with your note."
              : "Why not? The agent reads it at its next step, and Depo remembers it."}
          </label>
          <input
            id={inputId}
            // biome-ignore lint/a11y/noAutofocus: the owner just asked to type a reason here
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            maxLength={500}
            placeholder={
              isPlan ? "e.g. Skip the slides and keep it to the API" : "e.g. Use the standard library"
            }
            className={cn(inputClass, "h-7 w-auto min-w-48 flex-1")}
          />
          <Button type="submit" size="sm" disabled={respond.isPending}>
            <X aria-hidden /> Decline
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
        </form>
      )}
      {respond.isError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {(respond.error as Error).message}
        </p>
      )}
    </section>
  );
}
