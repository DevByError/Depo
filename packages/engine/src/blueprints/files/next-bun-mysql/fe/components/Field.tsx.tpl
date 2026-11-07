import type { InputHTMLAttributes } from "react";

/** A labelled input with its error under it (linked for screen readers). */
export function Field({
  id,
  label,
  error,
  ...input
}: { id: string; label: string; error?: string | undefined } & InputHTMLAttributes<HTMLInputElement>) {
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...input}
      />
      {error ? (
        <span id={errorId} className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
