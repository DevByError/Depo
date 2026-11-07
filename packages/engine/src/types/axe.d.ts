// `import axe from "axe-core/axe.min.js" with { type: "text" }` gives the script's source as a
// string (Bun), which `bun build --compile` embeds in the engine executable.
declare module "axe-core/axe.min.js" {
  const source: string;
  export default source;
}
