import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { candidateDirs, findBinaries } from "../src/devdb/binaries";
import { DevDatabaseService, databaseName, envFolders } from "../src/devdb/service";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

function setup() {
  const t = tempDir("depo devdb");
  const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
  const db = openDatabase({
    file: path.join(t.dir, "db", "t.db"),
    backupsDir: path.join(t.dir, "bk"),
    logger,
  });
  const bus = new EventBus(db.db, logger);
  const approvals = new ApprovalCenter(bus);
  const svc = new DevDatabaseService({
    dir: path.join(t.dir, "devdb"),
    toolsDir: path.join(t.dir, "tools"),
    bus,
    logger,
    approvals,
  });
  return {
    t,
    svc,
    bus,
    approvals,
    cleanup: () => {
      db.close();
      t.cleanup();
    },
  };
}

describe("test database helpers", () => {
  test("database names are safe identifiers", () => {
    expect(databaseName("Login Demo")).toBe("login_demo");
    expect(databaseName("3D Shop!")).toBe("app_3d_shop");
    expect(databaseName("Ünïcødé café")).toBe("unic_de_cafe");
    expect(databaseName("***")).toBe("app_db");
  });

  test("Depo's own MariaDB comes first, then PATH, then install folders", () => {
    const t = tempDir("depo bins");
    try {
      const bin = path.join(t.dir, "tools", "mariadb", "mariadb-11.4.5-winx64", "bin");
      fs.mkdirSync(bin, { recursive: true });
      for (const f of ["mariadbd.exe", "mariadb.exe", "mariadb-install-db.exe"])
        fs.writeFileSync(path.join(bin, f), "");
      const dirs = candidateDirs({
        toolsDir: path.join(t.dir, "tools"),
        platform: "win32",
        env: { PATH: "C:\\x;C:\\y" },
      });
      expect(dirs[0]).toEqual({ dir: bin, source: "depo" });
      expect(dirs.slice(1, 3).map((d) => d.source)).toEqual(["path", "path"]);
      expect(dirs.some((d) => d.dir === "C:\\xampp\\mysql\\bin")).toBe(true);
      const found = findBinaries({
        toolsDir: path.join(t.dir, "tools"),
        platform: "win32",
        env: { PATH: "" },
      });
      expect(found).toEqual({
        kind: "mariadb",
        server: path.join(bin, "mariadbd.exe"),
        client: path.join(bin, "mariadb.exe"),
        installDb: path.join(bin, "mariadb-install-db.exe"),
        source: "depo",
      });
    } finally {
      t.cleanup();
    }
  });

  test(".env files are written where the app reads its database settings", () => {
    const { t, svc, cleanup } = setup();
    try {
      const root = path.join(t.dir, "proj");
      fs.mkdirSync(path.join(root, "be"), { recursive: true });
      fs.mkdirSync(path.join(root, "fe"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "be", ".env.example"),
        "PORT=4000\nDATABASE_URL=\nNODE_ENV=development\n",
      );
      fs.writeFileSync(path.join(root, "fe", ".env.example"), "BACKEND_URL=http://127.0.0.1:4000\n");
      expect(envFolders(root)).toEqual([path.join(root, "be")]);
      const info = {
        projectId: "p",
        state: "running" as const,
        engine: "mariadb" as const,
        version: "11.4.5",
        port: 3307,
        database: "demo",
        user: "app",
        password: "pw",
        url: "mysql://app:pw@127.0.0.1:3307/demo",
        dataDir: null,
        message: null,
      };
      expect(svc.writeEnv(root, info)).toEqual(["be/.env"]);
      expect(fs.readFileSync(path.join(root, "be", ".env"), "utf8")).toBe(
        "PORT=4000\nDATABASE_URL=mysql://app:pw@127.0.0.1:3307/demo\nNODE_ENV=development\n",
      );
      // Unchanged the second time; an owner's own keys stay.
      fs.appendFileSync(path.join(root, "be", ".env"), "SECRET=mine\n");
      expect(svc.writeEnv(root, info)).toEqual([]);
      expect(fs.readFileSync(path.join(root, "be", ".env"), "utf8")).toContain("SECRET=mine");
    } finally {
      cleanup();
    }
  });
});

// A real server, when this machine has MariaDB or MySQL installed (CI installs MariaDB).
const real = findBinaries({ toolsDir: "/nonexistent" });
describe.skipIf(!real)("a real test database", () => {
  let ctx: ReturnType<typeof setup>;
  beforeAll(() => {
    ctx = setup();
  });
  afterAll(async () => {
    await ctx.svc.stopAll();
    ctx.cleanup();
  });

  test("starts, creates the database and user, runs SQL, resets and stops", async () => {
    const events: string[] = [];
    ctx.bus.subscribe((e) => events.push(e.text));
    const info = await ctx.svc.ensure("prj_test", { name: "Login Demo", taskId: null });
    expect(info.state).toBe("running");
    expect(info.database).toBe("login_demo");
    expect(info.url).toMatch(/^mysql:\/\/app:[A-Za-z0-9]{20}@127\.0\.0\.1:\d+\/login_demo$/);
    expect(events.some((t) => t.startsWith("Test database ready"))).toBe(true);
    await ctx.svc.sql("prj_test", "CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100))");
    await ctx.svc.sql("prj_test", "INSERT INTO users VALUES (1, 'demo@example.com')");
    expect(await ctx.svc.sql("prj_test", "SELECT email FROM users")).toContain("demo@example.com");
    // The app's user cannot reach other databases.
    await expect(ctx.svc.sql("prj_test", "SELECT * FROM mysql.user")).rejects.toThrow(/denied/i);
    // A second ensure reuses the running server and keeps the password.
    const again = await ctx.svc.ensure("prj_test", { name: "Login Demo" });
    expect(again.url).toBe(info.url);
    await ctx.svc.reset("prj_test", { name: "Login Demo" });
    await expect(ctx.svc.sql("prj_test", "SELECT * FROM users")).rejects.toThrow(/doesn't exist/i);
    expect(await ctx.svc.stop("prj_test")).toBe(true);
    expect((await ctx.svc.status("prj_test")).state).toBe("stopped");
    // Data survives a restart.
    await ctx.svc.ensure("prj_test", { name: "Login Demo" });
    await ctx.svc.sql("prj_test", "CREATE TABLE notes (id INT)");
    await ctx.svc.stop("prj_test");
    await ctx.svc.ensure("prj_test", { name: "Login Demo" });
    expect(await ctx.svc.sql("prj_test", "SHOW TABLES")).toContain("notes");
  }, 120_000);
});
