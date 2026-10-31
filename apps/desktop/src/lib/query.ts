import { QueryClient } from "@tanstack/react-query";

/** One query cache for the window; engine events invalidate parts of it (see lib/engine.ts). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
