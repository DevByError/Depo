// highlight.js ships types for its main entry and grammars, not for the core-only entry.
declare module "highlight.js/lib/core" {
  import type { HLJSApi } from "highlight.js";

  const hljs: HLJSApi;
  export default hljs;
}
