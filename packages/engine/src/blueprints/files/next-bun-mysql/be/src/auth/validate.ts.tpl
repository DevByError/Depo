/** Checks for sign up and sign in, with one plain message per field. */

export type FieldErrors = Record<string, string>;
export type Checked<T> = { ok: true; value: T } | { ok: false; fields: FieldErrors };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function checkRegister(body: unknown): Checked<{ name: string; email: string; password: string }> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = text(b.name);
  const email = text(b.email).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  const fields: FieldErrors = {};
  if (!name) fields.name = "Enter your name.";
  else if (name.length > 80) fields.name = "Use 80 characters or fewer.";
  if (!EMAIL.test(email) || email.length > 254) fields.email = "Enter a valid email address.";
  if (password.length < 8) fields.password = "Use at least 8 characters.";
  else if (password.length > 200) fields.password = "Use 200 characters or fewer.";
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: { name, email, password } };
}

export function checkLogin(body: unknown): Checked<{ email: string; password: string }> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const email = text(b.email).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  const fields: FieldErrors = {};
  if (!email) fields.email = "Enter your email address.";
  if (!password) fields.password = "Enter your password.";
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: { email, password } };
}
