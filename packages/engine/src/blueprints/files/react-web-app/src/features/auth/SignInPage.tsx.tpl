import { type FormEvent, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { Alert } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { AuthCard } from "./AuthCard";
import { type LoginErrors, validateLogin } from "./login-validate";

export function SignInPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<LoginErrors>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  if (status === "signed-in") return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateLogin(email, password);
    setErrors(found);
    setFormError("");
    if (found.email || found.password) return;
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not sign in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      footer={
        <>
          New here?{" "}
          <Link to="/sign-up" className="font-medium text-accent underline-offset-2 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && <Alert>{formError}</Alert>}
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </AuthCard>
  );
}
