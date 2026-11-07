// Generated list of the fullstack blueprint's template files (files/fullstack), embedded as text so
// `bun build --compile` ships them inside the engine. Every .tpl file there must be listed here;
// blueprints.test.ts checks it.
import gitattributes from "./files/fullstack/.gitattributes.tpl" with { type: "text" };
import gitignore from "./files/fullstack/.gitignore.tpl" with { type: "text" };
import readmeMd from "./files/fullstack/README.md.tpl" with { type: "text" };
import runCmd from "./files/fullstack/run.cmd.tpl" with { type: "text" };
import runPs1 from "./files/fullstack/run.ps1.tpl" with { type: "text" };
import runSh from "./files/fullstack/run.sh.tpl" with { type: "text" };
import testCmd from "./files/fullstack/test.cmd.tpl" with { type: "text" };
import testPs1 from "./files/fullstack/test.ps1.tpl" with { type: "text" };
import testSh from "./files/fullstack/test.sh.tpl" with { type: "text" };

export const FULLSTACK_TEMPLATES: Record<string, string> = {
  ".gitattributes": gitattributes,
  ".gitignore": gitignore,
  "README.md": readmeMd,
  "run.cmd": runCmd,
  "run.ps1": runPs1,
  "run.sh": runSh,
  "test.cmd": testCmd,
  "test.ps1": testPs1,
  "test.sh": testSh,
};
