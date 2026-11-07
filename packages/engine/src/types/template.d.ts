// `import x from "./file.py.tpl" with { type: "text" }` gives a blueprint template's content as a
// string (Bun). `bun build --compile` inlines it, so the blueprints ship inside the engine executable.
declare module "*.tpl" {
  const text: string;
  export default text;
}
