import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { Alert } from "@/components/ui/States";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AuthCard } from "./AuthCard";
import { validateLogin } from "./login-validate";

const MIN_PASSWORD = 8;

export function SignUpPage() {
  const { status, signUp } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  if (status === "signed-in") return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = "Enter your name.";
    const login = validateLogin(email, password);
    if (login.email) found.email = login.email;
    if (password.length < MIN_PASSWORD) found.password = `Use at least ${MIN_PASSWORD} characters.`;
    setErrors(found);
    setFormError("");
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await signUp(name.trim(), email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.details.length) setErrors(err.fieldErrors());
      setFormError(err instanceof Error ? err.message : "Could not create the account. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create an account"
      footer={
        <>
          Have an account?{" "}
          <Link to="/sign-in" className="font-medium text-accent underline-offset-2 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && <Alert>{formError}</Alert>}
        <TextField label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Creating your account..." : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
