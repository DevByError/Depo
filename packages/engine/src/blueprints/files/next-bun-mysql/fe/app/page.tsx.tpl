"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { ApiError, api, type User } from "@/lib/api";
import { initials } from "@/lib/validate";

/** Home: who is signed in, with Sign out; or the way to sign in. */
export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((err: unknown) => {
        setUser(null);
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
      });
  }, []);

  async function signOut() {
    setBusy(true);
    try {
      await api.logout();
      setUser(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign out.");
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined)
    return (
      <AuthCard title="Welcome">
        <p className="subtitle" role="status">
          Loading…
        </p>
      </AuthCard>
    );

  if (!user)
    return (
      <AuthCard title="Welcome" subtitle="Sign in to continue, or create an account.">
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="stack">
          <Link className="button" href="/login" style={{ display: "grid", placeItems: "center" }}>
            Sign in
          </Link>
          <Link className="button button-secondary" href="/register" style={{ display: "grid", placeItems: "center" }}>
            Create an account
          </Link>
        </div>
      </AuthCard>
    );

  return (
    <AuthCard title={`Hello, ${user.name.split(" ")[0]}`} subtitle="You are signed in.">
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="welcome">
        <span className="avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span>
          <strong>{user.name}</strong>
          <br />
          <span className="muted">{user.email}</span>
        </span>
      </div>
      <button type="button" className="button" onClick={signOut} disabled={busy}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </AuthCard>
  );
}
