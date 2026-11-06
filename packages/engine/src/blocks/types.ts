/**
 * A building block is a small, tested piece of a real system (login, roles, audit log...) that an
 * agent can add to a project instead of writing it from scratch. Blocks are self-contained: they
 * have no dependencies to install, ship their own tests, and say how to wire them in.
 * Depo itself has no login; these are for the systems Depo builds.
 */
export interface Block {
  id: string;
  name: string;
  description: string;
  stack: "ts" | "py" | "react" | "docker";
  tags: string[];
  files: { path: string; content: string }[];
  /** Command that runs the block's own tests (empty when it has none). */
  test: string;
  /** What to do after adding it. */
  notes: string[];
}
