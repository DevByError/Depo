// Generated list of the next-bun-mysql blueprint's template files (files/next-bun-mysql), embedded as text so
// `bun build --compile` ships them inside the engine. Every .tpl file there must be listed here;
// blueprints.test.ts checks it. Regenerate with: bun scripts/gen-blueprint-templates.ts
import gitattributes from "./files/next-bun-mysql/.gitattributes.tpl" with { type: "text" };
import gitignore from "./files/next-bun-mysql/.gitignore.tpl" with { type: "text" };
import beEnvExample from "./files/next-bun-mysql/be/.env.example.tpl" with { type: "text" };
import bePackageJson from "./files/next-bun-mysql/be/package.json.tpl" with { type: "text" };
import beSrcAppTestTs from "./files/next-bun-mysql/be/src/app.test.ts.tpl" with { type: "text" };
import beSrcAppTs from "./files/next-bun-mysql/be/src/app.ts.tpl" with { type: "text" };
import beSrcAuthPasswordTs from "./files/next-bun-mysql/be/src/auth/password.ts.tpl" with { type: "text" };
import beSrcAuthRoutesTs from "./files/next-bun-mysql/be/src/auth/routes.ts.tpl" with { type: "text" };
import beSrcAuthSessionsTs from "./files/next-bun-mysql/be/src/auth/sessions.ts.tpl" with { type: "text" };
import beSrcAuthValidateTs from "./files/next-bun-mysql/be/src/auth/validate.ts.tpl" with { type: "text" };
import beSrcConfigTs from "./files/next-bun-mysql/be/src/config.ts.tpl" with { type: "text" };
import beSrcDbMemoryTs from "./files/next-bun-mysql/be/src/db/memory.ts.tpl" with { type: "text" };
import beSrcDbMigrateTs from "./files/next-bun-mysql/be/src/db/migrate.ts.tpl" with { type: "text" };
import beSrcDbMysqlTs from "./files/next-bun-mysql/be/src/db/mysql.ts.tpl" with { type: "text" };
import beSrcDbSchemaSql from "./files/next-bun-mysql/be/src/db/schema.sql.tpl" with { type: "text" };
import beSrcDbSeedTs from "./files/next-bun-mysql/be/src/db/seed.ts.tpl" with { type: "text" };
import beSrcDbStoreTs from "./files/next-bun-mysql/be/src/db/store.ts.tpl" with { type: "text" };
import beSrcHttpTs from "./files/next-bun-mysql/be/src/http.ts.tpl" with { type: "text" };
import beSrcIndexTs from "./files/next-bun-mysql/be/src/index.ts.tpl" with { type: "text" };
import beSrcLimiterTs from "./files/next-bun-mysql/be/src/limiter.ts.tpl" with { type: "text" };
import beSrcSqlDTs from "./files/next-bun-mysql/be/src/sql.d.ts.tpl" with { type: "text" };
import beTsconfigJson from "./files/next-bun-mysql/be/tsconfig.json.tpl" with { type: "text" };
import feEnvExample from "./files/next-bun-mysql/fe/.env.example.tpl" with { type: "text" };
import feAppGlobalsCss from "./files/next-bun-mysql/fe/app/globals.css.tpl" with { type: "text" };
import feAppLayoutTsx from "./files/next-bun-mysql/fe/app/layout.tsx.tpl" with { type: "text" };
import feAppLoginPageTsx from "./files/next-bun-mysql/fe/app/login/page.tsx.tpl" with { type: "text" };
import feAppPageTsx from "./files/next-bun-mysql/fe/app/page.tsx.tpl" with { type: "text" };
import feAppRegisterPageTsx from "./files/next-bun-mysql/fe/app/register/page.tsx.tpl" with { type: "text" };
import feComponentsAuthCardTsx from "./files/next-bun-mysql/fe/components/AuthCard.tsx.tpl" with {
  type: "text",
};
import feComponentsFieldTsx from "./files/next-bun-mysql/fe/components/Field.tsx.tpl" with { type: "text" };
import feLibApiTs from "./files/next-bun-mysql/fe/lib/api.ts.tpl" with { type: "text" };
import feLibValidateTestTs from "./files/next-bun-mysql/fe/lib/validate.test.ts.tpl" with { type: "text" };
import feLibValidateTs from "./files/next-bun-mysql/fe/lib/validate.ts.tpl" with { type: "text" };
import feNextConfigTs from "./files/next-bun-mysql/fe/next.config.ts.tpl" with { type: "text" };
import fePackageJson from "./files/next-bun-mysql/fe/package.json.tpl" with { type: "text" };
import feTsconfigJson from "./files/next-bun-mysql/fe/tsconfig.json.tpl" with { type: "text" };
import readmeMd from "./files/next-bun-mysql/README.md.tpl" with { type: "text" };
import runCmd from "./files/next-bun-mysql/run.cmd.tpl" with { type: "text" };
import runSh from "./files/next-bun-mysql/run.sh.tpl" with { type: "text" };
import testCmd from "./files/next-bun-mysql/test.cmd.tpl" with { type: "text" };
import testSh from "./files/next-bun-mysql/test.sh.tpl" with { type: "text" };

export const NEXT_BUN_TEMPLATES: Record<string, string> = {
  ".gitattributes": gitattributes,
  ".gitignore": gitignore,
  "README.md": readmeMd,
  "be/.env.example": beEnvExample,
  "be/package.json": bePackageJson,
  "be/src/app.test.ts": beSrcAppTestTs,
  "be/src/app.ts": beSrcAppTs,
  "be/src/auth/password.ts": beSrcAuthPasswordTs,
  "be/src/auth/routes.ts": beSrcAuthRoutesTs,
  "be/src/auth/sessions.ts": beSrcAuthSessionsTs,
  "be/src/auth/validate.ts": beSrcAuthValidateTs,
  "be/src/config.ts": beSrcConfigTs,
  "be/src/db/memory.ts": beSrcDbMemoryTs,
  "be/src/db/migrate.ts": beSrcDbMigrateTs,
  "be/src/db/mysql.ts": beSrcDbMysqlTs,
  "be/src/db/schema.sql": beSrcDbSchemaSql,
  "be/src/db/seed.ts": beSrcDbSeedTs,
  "be/src/db/store.ts": beSrcDbStoreTs,
  "be/src/http.ts": beSrcHttpTs,
  "be/src/index.ts": beSrcIndexTs,
  "be/src/limiter.ts": beSrcLimiterTs,
  "be/src/sql.d.ts": beSrcSqlDTs,
  "be/tsconfig.json": beTsconfigJson,
  "fe/.env.example": feEnvExample,
  "fe/app/globals.css": feAppGlobalsCss,
  "fe/app/layout.tsx": feAppLayoutTsx,
  "fe/app/login/page.tsx": feAppLoginPageTsx,
  "fe/app/page.tsx": feAppPageTsx,
  "fe/app/register/page.tsx": feAppRegisterPageTsx,
  "fe/components/AuthCard.tsx": feComponentsAuthCardTsx,
  "fe/components/Field.tsx": feComponentsFieldTsx,
  "fe/lib/api.ts": feLibApiTs,
  "fe/lib/validate.test.ts": feLibValidateTestTs,
  "fe/lib/validate.ts": feLibValidateTs,
  "fe/next.config.ts": feNextConfigTs,
  "fe/package.json": fePackageJson,
  "fe/tsconfig.json": feTsconfigJson,
  "run.cmd": runCmd,
  "run.sh": runSh,
  "test.cmd": testCmd,
  "test.sh": testSh,
};
