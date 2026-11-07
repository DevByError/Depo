import { NavLink, Outlet } from "react-router";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/auth";
import { APP_NAME } from "@/lib/config";
import { ThemeToggle } from "./ThemeToggle";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-accent-soft font-medium text-fg" : "text-muted hover:bg-raised hover:text-fg"}`;

/** The frame of every signed-in screen: a skip link, navigation, the user and the page. */
export function AppLayout() {
  const { user, signOut } = useAuth();
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="font-semibold text-fg">{APP_NAME}</span>
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink to="/projects" className={navClass}>
              Projects
            </NavLink>
            {user?.role === "admin" && (
              <NavLink to="/users" className={navClass}>
                Users
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-sm text-muted sm:inline">{user?.name}</span>
            <ThemeToggle />
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 outline-none">
        <Outlet />
      </main>
    </div>
  );
}
