import { type DependencyList, useCallback, useEffect, useState } from "react";

export type AsyncState<T> =
  | { status: "loading"; data?: T; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: Error };

/**
 * Load data for a screen: loading, success and error states, a reload, and the old request
 * cancelled when the inputs change or the screen closes.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // The caller lists what `load` depends on in `deps`.
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ status: "loading", data: s.data }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "success", data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => controller.abort();
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
