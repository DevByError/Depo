// Generated list of the fastapi-service blueprint's template files (files/fastapi-service), embedded as text so
// `bun build --compile` ships them inside the engine. Every .tpl file there must be listed here;
// blueprints.test.ts checks it. Regenerate with: bun scripts/gen-blueprint-templates.ts
import dockerignore from "./files/fastapi-service/.dockerignore.tpl" with { type: "text" };
import envExample from "./files/fastapi-service/.env.example.tpl" with { type: "text" };
import gitattributes from "./files/fastapi-service/.gitattributes.tpl" with { type: "text" };
import gitignore from "./files/fastapi-service/.gitignore.tpl" with { type: "text" };
import appInitPy from "./files/fastapi-service/app/__init__.py.tpl" with { type: "text" };
import appApiInitPy from "./files/fastapi-service/app/api/__init__.py.tpl" with { type: "text" };
import appApiDepsPy from "./files/fastapi-service/app/api/deps.py.tpl" with { type: "text" };
import appApiRoutesInitPy from "./files/fastapi-service/app/api/routes/__init__.py.tpl" with { type: "text" };
import appApiRoutesAuthPy from "./files/fastapi-service/app/api/routes/auth.py.tpl" with { type: "text" };
import appApiRoutesHealthPy from "./files/fastapi-service/app/api/routes/health.py.tpl" with { type: "text" };
import appApiRoutesProjectsPy from "./files/fastapi-service/app/api/routes/projects.py.tpl" with {
  type: "text",
};
import appApiRoutesUsersPy from "./files/fastapi-service/app/api/routes/users.py.tpl" with { type: "text" };
import appCoreInitPy from "./files/fastapi-service/app/core/__init__.py.tpl" with { type: "text" };
import appCoreConfigPy from "./files/fastapi-service/app/core/config.py.tpl" with { type: "text" };
import appCoreErrorsPy from "./files/fastapi-service/app/core/errors.py.tpl" with { type: "text" };
import appCoreRateLimitPy from "./files/fastapi-service/app/core/rate_limit.py.tpl" with { type: "text" };
import appCoreRequestLogPy from "./files/fastapi-service/app/core/request_log.py.tpl" with { type: "text" };
import appCoreSecurityPy from "./files/fastapi-service/app/core/security.py.tpl" with { type: "text" };
import appDbInitPy from "./files/fastapi-service/app/db/__init__.py.tpl" with { type: "text" };
import appDbDatabasePy from "./files/fastapi-service/app/db/database.py.tpl" with { type: "text" };
import appDbMigrationsPy from "./files/fastapi-service/app/db/migrations.py.tpl" with { type: "text" };
import appMainPy from "./files/fastapi-service/app/main.py.tpl" with { type: "text" };
import appRepositoriesInitPy from "./files/fastapi-service/app/repositories/__init__.py.tpl" with {
  type: "text",
};
import appRepositoriesProjectsPy from "./files/fastapi-service/app/repositories/projects.py.tpl" with {
  type: "text",
};
import appRepositoriesUsersPy from "./files/fastapi-service/app/repositories/users.py.tpl" with {
  type: "text",
};
import appRepositoriesUtilPy from "./files/fastapi-service/app/repositories/util.py.tpl" with {
  type: "text",
};
import appSchemasInitPy from "./files/fastapi-service/app/schemas/__init__.py.tpl" with { type: "text" };
import appSchemasCommonPy from "./files/fastapi-service/app/schemas/common.py.tpl" with { type: "text" };
import appSchemasProjectsPy from "./files/fastapi-service/app/schemas/projects.py.tpl" with { type: "text" };
import appSchemasUsersPy from "./files/fastapi-service/app/schemas/users.py.tpl" with { type: "text" };
import appSeedPy from "./files/fastapi-service/app/seed.py.tpl" with { type: "text" };
import appServicesInitPy from "./files/fastapi-service/app/services/__init__.py.tpl" with { type: "text" };
import appServicesAuthPy from "./files/fastapi-service/app/services/auth.py.tpl" with { type: "text" };
import appServicesProjectsPy from "./files/fastapi-service/app/services/projects.py.tpl" with {
  type: "text",
};
import dockerfile from "./files/fastapi-service/Dockerfile.tpl" with { type: "text" };
import pytestIni from "./files/fastapi-service/pytest.ini.tpl" with { type: "text" };
import readmeMd from "./files/fastapi-service/README.md.tpl" with { type: "text" };
import requirementsTxt from "./files/fastapi-service/requirements.txt.tpl" with { type: "text" };
import requirementsDevTxt from "./files/fastapi-service/requirements-dev.txt.tpl" with { type: "text" };
import runCmd from "./files/fastapi-service/run.cmd.tpl" with { type: "text" };
import runPs1 from "./files/fastapi-service/run.ps1.tpl" with { type: "text" };
import runSh from "./files/fastapi-service/run.sh.tpl" with { type: "text" };
import testsInitPy from "./files/fastapi-service/tests/__init__.py.tpl" with { type: "text" };
import testsConftestPy from "./files/fastapi-service/tests/conftest.py.tpl" with { type: "text" };
import testsHelpersPy from "./files/fastapi-service/tests/helpers.py.tpl" with { type: "text" };
import testsTestAuthPy from "./files/fastapi-service/tests/test_auth.py.tpl" with { type: "text" };
import testsTestDatabasePy from "./files/fastapi-service/tests/test_database.py.tpl" with { type: "text" };
import testsTestHealthPy from "./files/fastapi-service/tests/test_health.py.tpl" with { type: "text" };
import testsTestProjectsPy from "./files/fastapi-service/tests/test_projects.py.tpl" with { type: "text" };
import testsTestRolesPy from "./files/fastapi-service/tests/test_roles.py.tpl" with { type: "text" };

export const FASTAPI_TEMPLATES: Record<string, string> = {
  ".dockerignore": dockerignore,
  ".env.example": envExample,
  ".gitattributes": gitattributes,
  ".gitignore": gitignore,
  Dockerfile: dockerfile,
  "README.md": readmeMd,
  "app/__init__.py": appInitPy,
  "app/api/__init__.py": appApiInitPy,
  "app/api/deps.py": appApiDepsPy,
  "app/api/routes/__init__.py": appApiRoutesInitPy,
  "app/api/routes/auth.py": appApiRoutesAuthPy,
  "app/api/routes/health.py": appApiRoutesHealthPy,
  "app/api/routes/projects.py": appApiRoutesProjectsPy,
  "app/api/routes/users.py": appApiRoutesUsersPy,
  "app/core/__init__.py": appCoreInitPy,
  "app/core/config.py": appCoreConfigPy,
  "app/core/errors.py": appCoreErrorsPy,
  "app/core/rate_limit.py": appCoreRateLimitPy,
  "app/core/request_log.py": appCoreRequestLogPy,
  "app/core/security.py": appCoreSecurityPy,
  "app/db/__init__.py": appDbInitPy,
  "app/db/database.py": appDbDatabasePy,
  "app/db/migrations.py": appDbMigrationsPy,
  "app/main.py": appMainPy,
  "app/repositories/__init__.py": appRepositoriesInitPy,
  "app/repositories/projects.py": appRepositoriesProjectsPy,
  "app/repositories/users.py": appRepositoriesUsersPy,
  "app/repositories/util.py": appRepositoriesUtilPy,
  "app/schemas/__init__.py": appSchemasInitPy,
  "app/schemas/common.py": appSchemasCommonPy,
  "app/schemas/projects.py": appSchemasProjectsPy,
  "app/schemas/users.py": appSchemasUsersPy,
  "app/seed.py": appSeedPy,
  "app/services/__init__.py": appServicesInitPy,
  "app/services/auth.py": appServicesAuthPy,
  "app/services/projects.py": appServicesProjectsPy,
  "pytest.ini": pytestIni,
  "requirements-dev.txt": requirementsDevTxt,
  "requirements.txt": requirementsTxt,
  "run.cmd": runCmd,
  "run.ps1": runPs1,
  "run.sh": runSh,
  "tests/__init__.py": testsInitPy,
  "tests/conftest.py": testsConftestPy,
  "tests/helpers.py": testsHelpersPy,
  "tests/test_auth.py": testsTestAuthPy,
  "tests/test_database.py": testsTestDatabasePy,
  "tests/test_health.py": testsTestHealthPy,
  "tests/test_projects.py": testsTestProjectsPy,
  "tests/test_roles.py": testsTestRolesPy,
};
