/** The same checks as the API, so mistakes show before sending. */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function checkRegisterForm(v: { name: string; email: string; password: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!v.name.trim()) errors.name = "Enter your name.";
  else if (v.name.trim().length > 80) errors.name = "Use 80 characters or fewer.";
  if (!EMAIL.test(v.email.trim())) errors.email = "Enter a valid email address.";
  if (v.password.length < 8) errors.password = "Use at least 8 characters.";
  return errors;
}

export function checkLoginForm(v: { email: string; password: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!v.email.trim()) errors.email = "Enter your email address.";
  if (!v.password) errors.password = "Enter your password.";
  return errors;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}
