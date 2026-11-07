"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Field } from "@/components/Field";
import { ApiError, api } from "@/lib/api";
import { checkLoginForm } from "@/lib/validate";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = checkLoginForm({ email, password });
    setErrors(found);
    setMessage("");
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await api.login({ email, password });
      router.push("/");
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setMessage(err.message);
      } else setMessage("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Use your email and password."
      footer={<>Demo account after seeding: demo@example.com / demo12345</>}
    >
      <form onSubmit={submit} noValidate aria-label="Sign in">
        {message ? (
          <p className="alert" role="alert">
            {message}
          </p>
        ) : null}
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          placeholder="you@example.com"
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          placeholder="Your password"
        />
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="switch-line">
        No account? <Link href="/register">Create an account</Link>
      </p>
    </AuthCard>
  );
}
