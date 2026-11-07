import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";

export const controlClass =
  "w-full rounded-md border border-border bg-panel px-3 py-2 text-sm text-fg placeholder:text-muted aria-[invalid=true]:border-danger";

interface FieldProps {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: (control: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode;
}

/** A label, the control, a hint and an error message, wired together for screen readers. */
export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children({
        id,
        ...(error ? { "aria-invalid": true as const } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

type WithField = { label: string; error?: string | undefined; hint?: string };

export function TextField({ label, error, hint, className = "", ...props }: WithField & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} error={error} {...(hint ? { hint } : {})}>
      {(control) => <input className={`${controlClass} ${className}`} {...control} {...props} />}
    </Field>
  );
}

export function TextArea({ label, error, hint, className = "", ...props }: WithField & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} error={error} {...(hint ? { hint } : {})}>
      {(control) => <textarea className={`${controlClass} ${className}`} rows={4} {...control} {...props} />}
    </Field>
  );
}

export function SelectField({ label, error, hint, className = "", children, ...props }: WithField & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} error={error} {...(hint ? { hint } : {})}>
      {(control) => (
        <select className={`${controlClass} ${className}`} {...control} {...props}>
          {children}
        </select>
      )}
    </Field>
  );
}
