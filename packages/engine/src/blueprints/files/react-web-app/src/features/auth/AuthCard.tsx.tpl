import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { APP_NAME } from "@/lib/config";

/** The centred card the sign-in and sign-up screens share. */
export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <p className="mb-4 text-sm font-semibold text-muted">{APP_NAME}</p>
      <div className="w-full max-w-sm rounded-xl border border-border bg-panel p-6 shadow-sm">
        <h1 className="mb-5 text-xl font-semibold text-fg">{title}</h1>
        {children}
      </div>
      <p className="mt-4 text-sm text-muted">{footer}</p>
    </main>
  );
}
