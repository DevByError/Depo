/**
 * A blueprint is a whole, tested starting point for a new system (an API, a web app, both). Agents
 * extend it instead of inventing structure from nothing; small local models write good code inside
 * a strong structure. Building blocks (../blocks) add one piece to a project that already exists.
 */
export interface BlueprintManifest {
  id: string;
  title: string;
  /** One line for cards and tool listings. */
  summary: string;
  /** Short stack tags, e.g. ["Python", "FastAPI"]. */
  stack: string[];
  /** "What you get", one plain line each. */
  features: string[];
  /** How to start it, from the project folder. */
  runCommand: string;
  /** How to run its own tests, from the project folder (after installing its packages). */
  testCommand: string;
  ports: number[];
  /**
   * For agents: where routes, models, services, tests and screens go, the naming, how to add a
   * resource end to end, and what never to remove. At most ~1200 characters (small contexts).
   */
  extendGuide: string;
  /** Lower-case words that make this blueprint a good match for a request. */
  keywords: string[];
}

export interface BlueprintVars {
  /** The project's name, as the owner typed it. */
  name: string;
  description?: string | undefined;
}

export interface BlueprintFile {
  /** Relative, forward slashes. */
  path: string;
  content: string;
}

export interface Blueprint extends BlueprintManifest {
  /** Every file, with the project's name filled in. */
  files(vars: BlueprintVars): BlueprintFile[];
}
