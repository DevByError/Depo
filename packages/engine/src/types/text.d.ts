// `import x from "./file.md" with { type: "text" }` gives the file's content as a string (Bun).
// `bun build --compile` inlines it, so the playbooks ship inside the engine executable.
declare module "*.md" {
  const text: string;
  export default text;
}
