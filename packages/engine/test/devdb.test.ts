import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import type { DbBinaries } from "../src/devdb/binaries";
import { candidateDirs, findBinaries } from "../src/devdb/binaries";
import { parseList, runsOn } from "../src/devdb/procs";
import { DevDatabaseService, databaseName, envFolders, serverErrors } from "../src/devdb/service";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

function setup(o: { binaries?: () => DbBinaries | null } = {}) {
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
    ...(o.binaries ? { binaries: o.binaries } : {}),
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

describe("a test database server left running", () => {
  test("is found by its data folder on the command line, never by its name alone", () => {
    const data = "C:\\Users\\baran\\AppData\\Local\\Depo\\devdb\\prj_1\\data";
    const mine = `"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe" --no-defaults --datadir=${data} --port=50538`;
    const service =
      '"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe" --defaults-file="C:\\ProgramData\\MySQL\\MySQL Server 8.0\\my.ini" MySQL80';
    expect(runsOn(mine, data, "win32")).toBe(true);
    expect(runsOn(mine.toLowerCase().replace(/\\/g, "/"), data, "win32")).toBe(true);
    expect(runsOn(service, data, "win32")).toBe(false);
    // Another project whose folder starts the same is not this one.
    expect(runsOn(`mysqld --datadir=${data}2 --port=1`, data, "win32")).toBe(false);
    expect(
      runsOn(
        "/usr/sbin/mariadbd --datadir=/home/a/devdb/p/data --port=3307",
        "/home/a/devdb/p/data",
        "linux",
      ),
    ).toBe(true);
    expect(
      runsOn(
        "/usr/sbin/mariadbd --datadir=/home/a/devdb/p/data --port=3307",
        "/home/a/devdb/P/data",
        "linux",
      ),
    ).toBe(false);
    expect(parseList("19628\tC:\\mysql\\bin\\mysqld.exe --datadir=C:\\x\r\n\r\n")).toEqual([
      { pid: 19628, command: "C:\\mysql\\bin\\mysqld.exe --datadir=C:\\x" },
    ]);
    expect(
      parseList(
        "  12 /usr/sbin/mysqld --datadir=/x\n  13 /usr/bin/node app.js\n  14 /opt/mariadb/bin/mariadbd --x",
        true,
      ).map((p) => p.pid),
    ).toEqual([12, 14]);
  });

  test("the start error shows the server's own error lines", () => {
    const log = [
      "2026-11-06T23:20:01.100000Z 0 [System] [MY-010116] [Server] mysqld (mysqld 8.0.44) starting as process 19628",
      "2026-11-06T23:20:01.200000Z 1 [ERROR] [MY-012271] [InnoDB] The innodb_system data file 'ibdata1' must be writable",
      "2026-11-06T23:20:01.300000Z 0 [ERROR] [MY-010119] [Server] Aborting",
    ].join("\r\n");
    expect(serverErrors(log)).toBe(
      "[ERROR] [MY-012271] [InnoDB] The innodb_system data file 'ibdata1' must be writable",
    );
    expect(serverErrors("2026-11-06 23:20:01 0 [ERROR] InnoDB: Unable to lock ./ibdata1 error: 11")).toBe(
      "[ERROR] InnoDB: Unable to lock ./ibdata1 error: 11",
    );
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

  test("a server left running on the data folder is stopped before the next start", async () => {
    await ctx.svc.ensure("prj_left", { name: "Left Over" });
    await ctx.svc.sql("prj_left", "CREATE TABLE kept (id INT)");
    const home = path.join(ctx.t.dir, "devdb", "prj_left");
    const pid = Number(fs.readFileSync(path.join(home, "server.pid"), "utf8"));
    // What the owner's PC had: a server Depo no longer knows about, and no saved settings.
    fs.rmSync(path.join(home, "instance.json"));
    const other = new DevDatabaseService({
      dir: path.join(ctx.t.dir, "devdb"),
      toolsDir: path.join(ctx.t.dir, "tools"),
      bus: ctx.bus,
      logger: createLogger({ dir: path.join(ctx.t.dir, "logs2"), level: "error", stderr: false }),
      approvals: ctx.approvals,
    });
    try {
      const info = await other.ensure("prj_left", { name: "Left Over" });
      expect(info.state).toBe("running");
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      expect(await other.sql("prj_left", "SHOW TABLES")).toContain("kept");
    } finally {
      await other.stop("prj_left");
    }
  }, 120_000);
});

// MySQL 8 itself, when DEPO_TEST_MYSQL8 names a folder with its `mysqld` and `mysql` programs.
const mysql8 = process.env.DEPO_TEST_MYSQL8;
describe.skipIf(!mysql8)("a real MySQL 8 test database", () => {
  test("starts (Depo can sign in from 127.0.0.1) and recovers from a server holding its files", async () => {
    const dir = mysql8 ?? "";
    const binaries = () =>
      ({ kind: "mysql", server: path.join(dir, "mysqld"), client: path.join(dir, "mysql") }) as DbBinaries;
    const a = setup({ binaries });
    try {
      const info = await a.svc.ensure("prj_m8", { name: "Skill Finder" });
      expect(info.engine).toBe("mysql");
      await a.svc.sql("prj_m8", "CREATE TABLE skills (id INT PRIMARY KEY)");
      // A second server on the same files (no pid file to point at it): the lock is seen and it is stopped.
      const home = path.join(a.t.dir, "devdb", "prj_m8");
      fs.rmSync(path.join(home, "server.pid"));
      fs.rmSync(path.join(home, "instance.json"));
      const b = new DevDatabaseService({
        dir: path.join(a.t.dir, "devdb"),
        toolsDir: path.join(a.t.dir, "tools"),
        bus: a.bus,
        logger: createLogger({ dir: path.join(a.t.dir, "logs2"), level: "error", stderr: false }),
        approvals: a.approvals,
        binaries,
      });
      const again = await b.ensure("prj_m8", { name: "Skill Finder" });
      expect(again.state).toBe("running");
      expect(await b.sql("prj_m8", "SHOW TABLES")).toContain("skills");
      await b.stop("prj_m8");
    } finally {
      await a.svc.stopAll();
      a.cleanup();
    }
  }, 240_000);
});
