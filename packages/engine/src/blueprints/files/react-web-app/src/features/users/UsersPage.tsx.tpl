import { useState } from "react";
import { controlClass } from "@/components/ui/Field";
import { Alert, EmptyState, ErrorState, Loading } from "@/components/ui/States";
import { type Role, type User, useAuth } from "@/lib/auth";
import { api } from "@/lib/session";
import { useAsync } from "@/lib/use-async";

interface UserPage {
  items: User[];
  total: number;
}

/** Admins only (the route and the API both check): see everyone and change their role. */
export function UsersPage() {
  const { user: me } = useAuth();
  const users = useAsync((signal) => api.get<UserPage>("/api/users", { page_size: 100 }, signal), []);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function changeRole(user: User, role: Role) {
    setSaving(user.id);
    setError("");
    try {
      await api.patch<User>(`/api/users/${user.id}/role`, { role });
      users.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the role.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section aria-labelledby="users-title" className="flex flex-col gap-4">
      <h1 id="users-title" className="text-xl font-semibold text-fg">
        Users
      </h1>
      {error && <Alert>{error}</Alert>}
      {users.status === "loading" && !users.data && <Loading label="Loading users" />}
      {users.status === "error" && <ErrorState error={users.error} onRetry={users.reload} />}
      {users.data && users.data.items.length === 0 && <EmptyState title="No users yet" />}
      {users.data && users.data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-panel">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users and their roles</caption>
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Role
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-2 text-fg">{u.name}</td>
                  <td className="px-4 py-2 text-muted">{u.email}</td>
                  <td className="px-4 py-2">
                    <select
                      aria-label={`Role of ${u.email}`}
                      value={u.role}
                      disabled={saving === u.id || u.id === me?.id}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      className={`${controlClass} w-auto py-1`}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.data.total > users.data.items.length && (
            <p className="px-4 py-2 text-xs text-muted">
              Showing {users.data.items.length} of {users.data.total}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
