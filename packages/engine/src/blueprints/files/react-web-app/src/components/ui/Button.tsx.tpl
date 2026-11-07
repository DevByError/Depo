import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const base =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-border bg-panel text-fg hover:bg-raised",
  danger: "bg-danger text-white hover:opacity-90 dark:text-bg",
  ghost: "text-muted hover:bg-raised hover:text-fg",
};

export function buttonClass(variant: Variant = "secondary", extra = ""): string {
  return `${base} ${variants[variant]} ${extra}`.trim();
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

/** A link that looks like a button (for navigation, not actions). */
export function ButtonLink({ variant = "secondary", className = "", ...props }: LinkProps & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}
