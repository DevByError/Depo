import { LOGIN_REACT } from "../blocks/other-blocks";
import { renderSet } from "./render";
import { WEB_TEMPLATES } from "./templates-react-web-app";
import type { Blueprint } from "./types";

const validator = LOGIN_REACT.files.find((f) => f.path === "src/components/login-validate.ts");
if (!validator) throw new Error("The login-form-react block has no login-validate.ts.");

/** The sign-in validation comes from the login-form-react building block, as it is. */
export const WEB_FROM_BLOCKS: Record<string, string> = {
  "src/features/auth/login-validate.ts": validator.content,
};

export const WEB_GUIDE = [
  "Layout: src/features/<name>/ holds api.ts (typed calls through the api client in src/lib/session.ts), its screens and their tests; shared UI in src/components/ui (Button, TextField, SelectField, Loading, EmptyState, ErrorState); routes in src/App.tsx; navigation in src/components/layout/AppLayout.tsx; colours only as tokens from src/styles.css (bg-panel, text-muted, bg-accent...).",
  "New screens (copy features/projects): 1 api.ts with the types and endpoints; 2 a list with search, filters and pages, a detail screen, one form for create and edit that shows server field errors (ApiError.fieldErrors()); 3 routes inside the RequireAuth layout (role='admin' for admin screens); 4 a Vitest test for the list that mocks ./api.",
  "Keep loading, empty and error states on every data screen, a label on every input, real buttons for actions.",
  "Install: npm install. Check: npm run typecheck and npm test.",
  "Never remove the sign-in flow, RequireAuth or the tests.",
].join("\n");

export const REACT_WEB_APP: Blueprint = {
  id: "react-web-app",
  title: "React web app",
  summary:
    "A Vite, React and TypeScript app with sign-in, a protected layout and a complete list, detail and form example.",
  stack: ["TypeScript", "React", "Vite", "Tailwind CSS", "Vitest"],
  features: [
    "Sign-in and sign-up screens and a protected layout with navigation",
    "A list with search, filters and pages, a detail screen and one form for create and edit",
    "Loading, empty and error states on every data screen",
    "A typed API client that shows the server's field errors next to the fields",
    "Accessible components, a skip link, and light and dark themes from one set of tokens",
    "An admin-only Users screen to change roles",
    "Vitest tests for the client, the sign-in screen and the list",
  ],
  runCommand: "npm run dev",
  testCommand: "npm test",
  ports: [5173],
  extendGuide: WEB_GUIDE,
  keywords: [
    "web app",
    "webapp",
    "frontend",
    "front-end",
    "react",
    "ui",
    "dashboard",
    "spa",
    "vite",
    "website",
    "screens",
  ],
  files: (vars) => renderSet(WEB_TEMPLATES, vars, "", WEB_FROM_BLOCKS),
};
