// `import x from "./file.wasm" with { type: "file" }` gives the file's path (Bun).
declare module "*.wasm" {
  const path: string;
  export default path;
}
