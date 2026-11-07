import { ButtonLink } from "@/components/ui/Button";

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold text-fg">This page does not exist</h1>
      <p className="text-sm text-muted">The link may be old, or the address has a typo.</p>
      <ButtonLink to="/" variant="primary">
        Go to the start
      </ButtonLink>
    </main>
  );
}
