import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Loading } from "@/components/ui/States";
import { type Role, useAuth } from "@/lib/auth";

/** Signed-out visitors go to the sign-in screen and come back here afterwards. */
export function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Loading label="Checking your session" />;
  if (status === "signed-out" || !user) {
    return <Navigate to="/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  // The API checks roles too; this only keeps people away from screens they cannot use.
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return <>{children}</>;
}
