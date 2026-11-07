// Generated list of the react-web-app blueprint's template files (files/react-web-app), embedded as text so
// `bun build --compile` ships them inside the engine. Every .tpl file there must be listed here;
// blueprints.test.ts checks it. Regenerate with: bun scripts/gen-blueprint-templates.ts
import envExample from "./files/react-web-app/.env.example.tpl" with { type: "text" };
import gitattributes from "./files/react-web-app/.gitattributes.tpl" with { type: "text" };
import gitignore from "./files/react-web-app/.gitignore.tpl" with { type: "text" };
import indexHtml from "./files/react-web-app/index.html.tpl" with { type: "text" };
import packageJson from "./files/react-web-app/package.json.tpl" with { type: "text" };
import publicFaviconSvg from "./files/react-web-app/public/favicon.svg.tpl" with { type: "text" };
import readmeMd from "./files/react-web-app/README.md.tpl" with { type: "text" };
import runCmd from "./files/react-web-app/run.cmd.tpl" with { type: "text" };
import runPs1 from "./files/react-web-app/run.ps1.tpl" with { type: "text" };
import runSh from "./files/react-web-app/run.sh.tpl" with { type: "text" };
import srcAppTsx from "./files/react-web-app/src/App.tsx.tpl" with { type: "text" };
import srcComponentsLayoutAppLayoutTsx from "./files/react-web-app/src/components/layout/AppLayout.tsx.tpl" with {
  type: "text",
};
import srcComponentsLayoutRequireAuthTsx from "./files/react-web-app/src/components/layout/RequireAuth.tsx.tpl" with {
  type: "text",
};
import srcComponentsLayoutThemeToggleTsx from "./files/react-web-app/src/components/layout/ThemeToggle.tsx.tpl" with {
  type: "text",
};
import srcComponentsUiButtonTsx from "./files/react-web-app/src/components/ui/Button.tsx.tpl" with {
  type: "text",
};
import srcComponentsUiFieldTsx from "./files/react-web-app/src/components/ui/Field.tsx.tpl" with {
  type: "text",
};
import srcComponentsUiStatesTsx from "./files/react-web-app/src/components/ui/States.tsx.tpl" with {
  type: "text",
};
import srcFeaturesAuthAuthCardTsx from "./files/react-web-app/src/features/auth/AuthCard.tsx.tpl" with {
  type: "text",
};
import srcFeaturesAuthLoginValidateTestTs from "./files/react-web-app/src/features/auth/login-validate.test.ts.tpl" with {
  type: "text",
};
import srcFeaturesAuthSignInPageTestTsx from "./files/react-web-app/src/features/auth/SignInPage.test.tsx.tpl" with {
  type: "text",
};
import srcFeaturesAuthSignInPageTsx from "./files/react-web-app/src/features/auth/SignInPage.tsx.tpl" with {
  type: "text",
};
import srcFeaturesAuthSignUpPageTsx from "./files/react-web-app/src/features/auth/SignUpPage.tsx.tpl" with {
  type: "text",
};
import srcFeaturesProjectsApiTs from "./files/react-web-app/src/features/projects/api.ts.tpl" with {
  type: "text",
};
import srcFeaturesProjectsProjectDetailPageTsx from "./files/react-web-app/src/features/projects/ProjectDetailPage.tsx.tpl" with {
  type: "text",
};
import srcFeaturesProjectsProjectFormPageTsx from "./files/react-web-app/src/features/projects/ProjectFormPage.tsx.tpl" with {
  type: "text",
};
import srcFeaturesProjectsProjectsPageTestTsx from "./files/react-web-app/src/features/projects/ProjectsPage.test.tsx.tpl" with {
  type: "text",
};
import srcFeaturesProjectsProjectsPageTsx from "./files/react-web-app/src/features/projects/ProjectsPage.tsx.tpl" with {
  type: "text",
};
import srcFeaturesProjectsStatusBadgeTsx from "./files/react-web-app/src/features/projects/StatusBadge.tsx.tpl" with {
  type: "text",
};
import srcFeaturesUsersUsersPageTsx from "./files/react-web-app/src/features/users/UsersPage.tsx.tpl" with {
  type: "text",
};
import srcLibApiTestTs from "./files/react-web-app/src/lib/api.test.ts.tpl" with { type: "text" };
import srcLibApiTs from "./files/react-web-app/src/lib/api.ts.tpl" with { type: "text" };
import srcLibAuthTsx from "./files/react-web-app/src/lib/auth.tsx.tpl" with { type: "text" };
import srcLibConfigTs from "./files/react-web-app/src/lib/config.ts.tpl" with { type: "text" };
import srcLibFormatTs from "./files/react-web-app/src/lib/format.ts.tpl" with { type: "text" };
import srcLibSessionTs from "./files/react-web-app/src/lib/session.ts.tpl" with { type: "text" };
import srcLibThemeTs from "./files/react-web-app/src/lib/theme.ts.tpl" with { type: "text" };
import srcLibUseAsyncTs from "./files/react-web-app/src/lib/use-async.ts.tpl" with { type: "text" };
import srcMainTsx from "./files/react-web-app/src/main.tsx.tpl" with { type: "text" };
import srcPagesNotFoundPageTsx from "./files/react-web-app/src/pages/NotFoundPage.tsx.tpl" with {
  type: "text",
};
import srcStylesCss from "./files/react-web-app/src/styles.css.tpl" with { type: "text" };
import srcTestSetupTs from "./files/react-web-app/src/test/setup.ts.tpl" with { type: "text" };
import srcViteEnvDTs from "./files/react-web-app/src/vite-env.d.ts.tpl" with { type: "text" };
import tsconfigJson from "./files/react-web-app/tsconfig.json.tpl" with { type: "text" };
import viteConfigTs from "./files/react-web-app/vite.config.ts.tpl" with { type: "text" };

export const WEB_TEMPLATES: Record<string, string> = {
  ".env.example": envExample,
  ".gitattributes": gitattributes,
  ".gitignore": gitignore,
  "README.md": readmeMd,
  "index.html": indexHtml,
  "package.json": packageJson,
  "public/favicon.svg": publicFaviconSvg,
  "run.cmd": runCmd,
  "run.ps1": runPs1,
  "run.sh": runSh,
  "src/App.tsx": srcAppTsx,
  "src/components/layout/AppLayout.tsx": srcComponentsLayoutAppLayoutTsx,
  "src/components/layout/RequireAuth.tsx": srcComponentsLayoutRequireAuthTsx,
  "src/components/layout/ThemeToggle.tsx": srcComponentsLayoutThemeToggleTsx,
  "src/components/ui/Button.tsx": srcComponentsUiButtonTsx,
  "src/components/ui/Field.tsx": srcComponentsUiFieldTsx,
  "src/components/ui/States.tsx": srcComponentsUiStatesTsx,
  "src/features/auth/AuthCard.tsx": srcFeaturesAuthAuthCardTsx,
  "src/features/auth/SignInPage.test.tsx": srcFeaturesAuthSignInPageTestTsx,
  "src/features/auth/SignInPage.tsx": srcFeaturesAuthSignInPageTsx,
  "src/features/auth/SignUpPage.tsx": srcFeaturesAuthSignUpPageTsx,
  "src/features/auth/login-validate.test.ts": srcFeaturesAuthLoginValidateTestTs,
  "src/features/projects/ProjectDetailPage.tsx": srcFeaturesProjectsProjectDetailPageTsx,
  "src/features/projects/ProjectFormPage.tsx": srcFeaturesProjectsProjectFormPageTsx,
  "src/features/projects/ProjectsPage.test.tsx": srcFeaturesProjectsProjectsPageTestTsx,
  "src/features/projects/ProjectsPage.tsx": srcFeaturesProjectsProjectsPageTsx,
  "src/features/projects/StatusBadge.tsx": srcFeaturesProjectsStatusBadgeTsx,
  "src/features/projects/api.ts": srcFeaturesProjectsApiTs,
  "src/features/users/UsersPage.tsx": srcFeaturesUsersUsersPageTsx,
  "src/lib/api.test.ts": srcLibApiTestTs,
  "src/lib/api.ts": srcLibApiTs,
  "src/lib/auth.tsx": srcLibAuthTsx,
  "src/lib/config.ts": srcLibConfigTs,
  "src/lib/format.ts": srcLibFormatTs,
  "src/lib/session.ts": srcLibSessionTs,
  "src/lib/theme.ts": srcLibThemeTs,
  "src/lib/use-async.ts": srcLibUseAsyncTs,
  "src/main.tsx": srcMainTsx,
  "src/pages/NotFoundPage.tsx": srcPagesNotFoundPageTsx,
  "src/styles.css": srcStylesCss,
  "src/test/setup.ts": srcTestSetupTs,
  "src/vite-env.d.ts": srcViteEnvDTs,
  "tsconfig.json": tsconfigJson,
  "vite.config.ts": viteConfigTs,
};
