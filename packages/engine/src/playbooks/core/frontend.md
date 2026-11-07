## Definition of done
- The design tokens are used everywhere (CSS variables or the Tailwind theme); no unexplained colors, sizes or spacing inside components.
- Every data view has loading (skeleton), empty (with the first action), error (message and retry) and success states; protected views handle signed-out and permission-denied.
- Forms: visible labels, client validation with a schema that matches the API, server errors shown next to the right field, submit disabled while pending, no double submits.
- Keyboard works everywhere with a visible focus ring; semantic elements (button, a, nav, main, h1 to h3 in order); dialogs trap focus, close on Escape and return focus; async status is announced (aria-live).
- Layouts work at 360, 768, 1024 and 1440 px without horizontal scrolling.
- All API calls go through one typed client with the base URL from the environment; endpoints come from the OpenAPI contract.
- Tests cover the screen states and the main form; the build, lint and type checks pass.

## Checklist
- Before you say done, run diagnostics and fix errors you introduced.
- Data fetching with a cache (TanStack Query, server components or SWR), with cancellation and invalidation after mutations.
- Auth: prefer HttpOnly cookies set by the API; guard routes; hide or disable actions the user may not take (the server still enforces).
- Code-split routes, lazy-load heavy parts, give images width and height.
- Lists that can grow are paginated or virtualised; tables have sorting and filters when the stories need them.
- Write copy that is short and plain; buttons say what they do ("Save booking").
- After building UI: start_preview, then check_page on each page you changed at phone, tablet and desktop (add steps for the main form). Fix console errors, failed requests and critical or serious accessibility issues before you hand off.

## Avoid
- div or span with onClick instead of button; placeholder used as a label.
- Fetching in useEffect without handling loading, errors and races.
- Swallowing errors or showing raw error objects; silent failures.
- Hardcoded API URLs; secrets in VITE_, NEXT_PUBLIC_ or EXPO_PUBLIC_ variables (they ship to every user).
