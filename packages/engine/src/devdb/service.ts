import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalCenter } from "../approvals";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import { choosePort, isListening } from "../preview/ports";
import { writeStream } from "../util/github";
import { extractZip } from "../util/unzip";
import { type DbBinaries, findBinaries } from "./binaries";

/**
 * Test databases: one MySQL-compatible database per project, run by Depo on 127.0.0.1, so agents
 * can create tables and demo data and the owner can try the app before setting up a database of
 * their own. MariaDB (or an installed MySQL) runs from Depo's data folder with its own data
 * directory and a random password for the app's user. On Windows, when no server is installed,
 * Depo downloads the portable MariaDB once (after the owner allows it). Nothing listens beyond
 * the loopback address, and the data stays until the owner resets it.
 */

export type DevDbState = "missing" | "stopped" | "starting" | "running" | "failed";

export interface DevDbInfo {
  projectId: string;
  state: DevDbState;
  engine: "mariadb" | "mysql" | null;
  version: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
  password: string | null;
  /** mysql://user:password@127.0.0.1:port/database */
  url: string | null;
  dataDir: string | null;
  message: string | null;
}

interface Instance {
  engine: "mariadb" | "mysql";
  version: string;
  port: number;
  database: string;
  user: string;
  password: string;
  createdAt: string;
}

export interface DevDbOptions {
  /** `<data>/devdb`: one folder per project. */
  dir: string;
  /** `<data>/tools`: the portable MariaDB is unpacked under `mariadb/`. */
  toolsDir: string;
  bus: EventBus;
  logger: Logger;
  approvals: ApprovalCenter;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Override where the server comes from (tests). */
  binaries?: () => DbBinaries | null;
}

/** The portable MariaDB Depo downloads on Windows (a long-term support release). */
export const MARIADB_VERSION = "11.4.5";
const MARIADB_BASE = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages`;
export const MARIADB_ZIP = `${MARIADB_BASE}/mariadb-${MARIADB_VERSION}-winx64.zip`;
const MARIADB_SUMS = `${MARIADB_BASE}/sha256sums.txt`;
const MAX_ZIP = 400 * 1024 * 1024;

const START_TIMEOUT_MS = 90_000;
const SQL_TIMEOUT_MS = 30_000;
const MAX_SQL_OUTPUT = 12_000;

export class DevDbError extends Error {}

/** A database name from a project name: lower case letters, digits and underscores. */
export function databaseName(projectName: string): string {
  const base = projectName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base && !/^\d/.test(base) ? base : `app_${base || "db"}`;
}

export function databaseUrl(i: Pick<Instance, "user" | "password" | "port" | "database">): string {
  return `mysql://${encodeURIComponent(i.user)}:${encodeURIComponent(i.password)}@127.0.0.1:${i.port}/${i.database}`;
}

function password(): string {
  // Letters and digits only: safe in a URL, a .env file and every shell.
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return [...randomBytes(20)].map((b) => abc[b % abc.length]).join("");
}

/** Quote a MySQL identifier. */
function ident(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Quote a MySQL string. */
function str(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface Proc {
  proc: ReturnType<typeof Bun.spawn>;
  exited: Promise<number>;
}

export class DevDatabaseService {
  private readonly procs = new Map<string, Proc>();
  private readonly busy = new Map<string, Promise<DevDbInfo>>();
  private readonly failures = new Map<string, string>();
  private readonly kinds = new Map<string, { kind: "mariadb" | "mysql"; version: string }>();
  private installing: Promise<DbBinaries> | null = null;
  private readonly log: Logger;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly o: DevDbOptions) {
    this.log = o.logger.child({ component: "devdb" });
    this.platform = o.platform ?? process.platform;
  }

  // ---- where things are --------------------------------------------------------------------

  binaries(): DbBinaries | null {
    return this.o.binaries
      ? this.o.binaries()
      : findBinaries({ toolsDir: this.o.toolsDir, platform: this.platform, env: this.o.env });
  }

  private home(projectId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new DevDbError("Invalid project id.");
    return path.join(this.o.dir, projectId);
  }

  private dataDir(projectId: string): string {
    return path.join(this.home(projectId), "data");
  }

  private load(projectId: string): Instance | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.home(projectId), "instance.json"), "utf8"),
      ) as Instance;
    } catch {
      return null;
    }
  }

  private save(projectId: string, i: Instance): void {
    fs.mkdirSync(this.home(projectId), { recursive: true });
    fs.writeFileSync(path.join(this.home(projectId), "instance.json"), JSON.stringify(i, null, 2));
  }

  // ---- status ------------------------------------------------------------------------------

  /** What Depo knows without starting anything (a quick port check tells running from stopped). */
  async status(projectId: string): Promise<DevDbInfo> {
    const i = this.load(projectId);
    const running = i ? this.procs.has(projectId) || (await isListening(i.port)) : false;
    const failure = this.failures.get(projectId) ?? null;
    const state: DevDbState = this.busy.has(projectId)
      ? "starting"
      : running
        ? "running"
        : failure
          ? "failed"
          : !i && !this.binaries() && this.platform !== "win32"
            ? "missing"
            : "stopped";
    return this.info(projectId, i, state, failure);
  }

  private info(projectId: string, i: Instance | null, state: DevDbState, message: string | null): DevDbInfo {
    return {
      projectId,
      state,
      engine: i?.engine ?? null,
      version: i?.version ?? null,
      port: i?.port ?? null,
      database: i?.database ?? null,
      user: i?.user ?? null,
      password: i?.password ?? null,
      url: i ? databaseUrl(i) : null,
      dataDir: i ? this.dataDir(projectId) : null,
      message,
    };
  }

  // ---- start -------------------------------------------------------------------------------

  /**
   * The project's test database, running and ready (created the first time). Concurrent callers
   * share one start. Throws DevDbError with a plain reason when it cannot start.
   */
  ensure(
    projectId: string,
    o: { name: string; taskId?: string | null; agent?: string; signal?: AbortSignal },
  ): Promise<DevDbInfo> {
    const running = this.busy.get(projectId);
    if (running) return running;
    const p = this.start(projectId, o)
      .then((info) => {
        this.failures.delete(projectId);
        return info;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.failures.set(projectId, msg);
        throw err instanceof DevDbError ? err : new DevDbError(msg);
      })
      .finally(() => this.busy.delete(projectId));
    this.busy.set(projectId, p);
    return p;
  }

  private async start(
    projectId: string,
    o: { name: string; taskId?: string | null; agent?: string; signal?: AbortSignal },
  ): Promise<DevDbInfo> {
    const agent = o.agent ?? "engine";
    let bins = this.binaries();
    if (!bins) bins = await this.install({ projectId, taskId: o.taskId ?? null, agent, signal: o.signal });
    const kind = await this.detectKind(bins);
    let inst = this.load(projectId);
    const t0 = performance.now();
    if (inst && (await this.ping(bins, inst.port))) {
      await this.provision(bins, inst);
      return this.info(projectId, inst, "running", null);
    }
    const port = await choosePort(inst?.port ?? 3307);
    inst = inst
      ? { ...inst, port }
      : {
          engine: kind.kind,
          version: kind.version,
          port,
          database: databaseName(o.name),
          user: "app",
          password: password(),
          createdAt: new Date().toISOString(),
        };
    this.o.bus.emit({
      agent,
      projectId,
      taskId: o.taskId ?? null,
      type: "running_command",
      text: `Starting the test database (${kind.kind === "mariadb" ? "MariaDB" : "MySQL"} ${kind.version}) on port ${port}`,
      status: "started",
    });
    const data = this.dataDir(projectId);
    if (!this.initialized(data)) await this.initialize(bins, kind.kind, data, port);
    await this.launch(projectId, bins, kind.kind, port);
    await this.provision(bins, inst);
    this.save(projectId, { ...inst, engine: kind.kind, version: kind.version });
    const info = this.info(projectId, this.load(projectId), "running", null);
    this.o.bus.emit({
      agent,
      projectId,
      taskId: o.taskId ?? null,
      type: "running_command",
      text: `Test database ready: ${inst.database} on 127.0.0.1:${port}`,
      details: { database: inst.database, port, engine: kind.kind },
      durationMs: Math.round(performance.now() - t0),
      status: "succeeded",
    });
    this.log.info("test database started", { projectId, port, engine: kind.kind });
    return info;
  }

  private initialized(data: string): boolean {
    return fs.existsSync(path.join(data, "mysql"));
  }

  private async detectKind(bins: DbBinaries): Promise<{ kind: "mariadb" | "mysql"; version: string }> {
    const known = this.kinds.get(bins.server);
    if (known) return known;
    const r = await this.exec([bins.server, "--version"], { timeoutMs: 20_000 });
    const text = r.output;
    const kind = /mariadb/i.test(text) ? "mariadb" : /mysql/i.test(text) ? "mysql" : bins.kind;
    const version = /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? "unknown";
    const out = { kind, version } as const;
    this.kinds.set(bins.server, out);
    return out;
  }

  private rootUser(): string[] {
    return process.getuid?.() === 0 ? ["--user=root"] : [];
  }

  private socketPath(projectId: string): string {
    const p = path.join(this.home(projectId), "mysql.sock");
    // Unix socket paths are limited to about 104 characters.
    return p.length < 100 ? p : path.join(os.tmpdir(), `depo-db-${projectId.slice(-12)}.sock`);
  }

  private async initialize(
    bins: DbBinaries,
    kind: "mariadb" | "mysql",
    data: string,
    port: number,
  ): Promise<void> {
    fs.rmSync(data, { recursive: true, force: true });
    let argv: string[];
    if (kind === "mariadb" && bins.installDb && this.platform === "win32") {
      // The Windows installer makes the folder itself and leaves root without a password.
      fs.mkdirSync(path.dirname(data), { recursive: true });
      argv = [bins.installDb, `--datadir=${data}`, `--port=${port}`];
    } else if (kind === "mariadb" && bins.installDb) {
      fs.mkdirSync(data, { recursive: true });
      argv = [
        bins.installDb,
        "--no-defaults",
        `--datadir=${data}`,
        "--auth-root-authentication-method=normal",
        "--skip-test-db",
        // No --user: as root the files are root's anyway, and the script's chown breaks on spaces.
      ];
      const base = path.dirname(path.dirname(bins.server));
      // A portable (unpacked) MariaDB needs to be told where its files are.
      if (!["/usr", "/usr/local", "/opt/homebrew"].includes(base)) argv.push(`--basedir=${base}`);
    } else {
      fs.mkdirSync(path.dirname(data), { recursive: true });
      argv = [bins.server, "--no-defaults", "--initialize-insecure", `--datadir=${data}`, ...this.rootUser()];
    }
    const r = await this.exec(argv, { timeoutMs: 180_000 });
    if (r.exitCode !== 0 || !this.initialized(data))
      throw new DevDbError(
        `Could not create the test database's data folder (exit ${r.exitCode}). ${lastLines(r.output, 6)}`,
      );
  }

  private async launch(
    projectId: string,
    bins: DbBinaries,
    kind: "mariadb" | "mysql",
    port: number,
  ): Promise<void> {
    const home = this.home(projectId);
    const logFile = path.join(home, "server.log");
    const argv = [
      bins.server,
      "--no-defaults",
      `--datadir=${this.dataDir(projectId)}`,
      `--port=${port}`,
      "--bind-address=127.0.0.1",
      "--skip-name-resolve",
      `--pid-file=${path.join(home, "server.pid")}`,
      `--log-error=${logFile}`,
      "--character-set-server=utf8mb4",
      ...(this.platform === "win32" ? [] : [`--socket=${this.socketPath(projectId)}`]),
      ...(kind === "mysql"
        ? ["--mysqlx=OFF", "--collation-server=utf8mb4_0900_ai_ci"]
        : ["--collation-server=utf8mb4_unicode_ci"]),
      ...this.rootUser(),
    ];
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
      env: this.childEnv(),
    });
    const exited = proc.exited.then((code) => {
      if (this.procs.get(projectId)?.proc === proc) this.procs.delete(projectId);
      this.log.info("test database stopped", { projectId, code });
      return code;
    });
    this.procs.set(projectId, { proc, exited });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.procs.has(projectId)) break;
      if ((await isListening(port)) && (await this.ping(bins, port))) return;
      await Bun.sleep(400);
    }
    if (this.procs.has(projectId)) proc.kill();
    let tail = "";
    try {
      tail = lastLines(fs.readFileSync(logFile, "utf8"), 8);
    } catch {
      tail = "";
    }
    throw new DevDbError(`The test database did not start on port ${port}. ${tail}`.trim());
  }

  /** Create the database and the app's user (idempotent; also resets the password to the saved one). */
  private async provision(bins: DbBinaries, i: Instance): Promise<void> {
    const db = ident(i.database);
    const pw = str(i.password);
    const sql = [
      `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4`,
      ...["127.0.0.1", "localhost"].flatMap((host) => [
        `CREATE USER IF NOT EXISTS ${str(i.user)}@${str(host)} IDENTIFIED BY ${pw}`,
        `ALTER USER ${str(i.user)}@${str(host)} IDENTIFIED BY ${pw}`,
        `GRANT ALL PRIVILEGES ON ${db}.* TO ${str(i.user)}@${str(host)}`,
      ]),
      "FLUSH PRIVILEGES",
    ].join("; ");
    const r = await this.client(bins, i.port, { user: "root" }, sql);
    if (r.exitCode !== 0)
      throw new DevDbError(`Could not create the database and its user. ${lastLines(r.output, 4)}`);
  }

  private async ping(bins: DbBinaries, port: number): Promise<boolean> {
    if (!(await isListening(port))) return false;
    const r = await this.client(bins, port, { user: "root" }, "SELECT 1", 10_000);
    return r.exitCode === 0;
  }

  // ---- queries -----------------------------------------------------------------------------

  /** Run SQL as the app's user in the project's database; returns the output as a text table. */
  async sql(projectId: string, query: string): Promise<string> {
    const i = this.load(projectId);
    const bins = this.binaries();
    if (!i || !bins || !(await isListening(i.port)))
      throw new DevDbError("The test database is not running. Start it first.");
    const r = await this.client(
      bins,
      i.port,
      { user: i.user, password: i.password, database: i.database, table: true },
      query,
    );
    const out = r.output.trim();
    if (r.exitCode !== 0) throw new DevDbError(out || `The query failed (exit ${r.exitCode}).`);
    if (!out) return "OK (no rows returned).";
    return out.length > MAX_SQL_OUTPUT
      ? `${out.slice(0, MAX_SQL_OUTPUT)}\n… (cut: ${out.length} characters)`
      : out;
  }

  /** Drop every table: the database is made again, empty, with the same user and password. */
  async reset(
    projectId: string,
    o: { name: string; taskId?: string | null; agent?: string },
  ): Promise<DevDbInfo> {
    const info = await this.ensure(projectId, o);
    const i = this.load(projectId);
    const bins = this.binaries();
    if (!i || !bins) return info;
    const r = await this.client(
      bins,
      i.port,
      { user: "root" },
      `DROP DATABASE IF EXISTS ${ident(i.database)}`,
    );
    if (r.exitCode !== 0) throw new DevDbError(`Could not empty the database. ${lastLines(r.output, 4)}`);
    await this.provision(bins, i);
    this.o.bus.emit({
      agent: o.agent ?? "engine",
      projectId,
      taskId: o.taskId ?? null,
      type: "info",
      text: `Test database ${i.database} emptied`,
      status: "succeeded",
    });
    return this.info(projectId, i, "running", null);
  }

  // ---- stop --------------------------------------------------------------------------------

  async stop(projectId: string): Promise<boolean> {
    const i = this.load(projectId);
    const bins = this.binaries();
    const own = this.procs.get(projectId);
    if (!i || !(own || (await isListening(i.port)))) return false;
    // A clean shutdown keeps InnoDB from recovering on the next start.
    if (bins) await this.client(bins, i.port, { user: "root" }, "SHUTDOWN", 10_000).catch(() => undefined);
    if (own) {
      const done = await Promise.race([own.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
      if (!done) own.proc.kill();
    }
    this.log.info("test database stop requested", { projectId });
    return true;
  }

  /** Stop the servers this engine started (engine shutdown). */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.procs.keys()].map((id) => this.stop(id)));
  }

  // ---- .env --------------------------------------------------------------------------------

  /**
   * Point the app at the test database: DATABASE_URL (and DB_* / MYSQL_* keys the app already
   * uses) in the `.env` of each folder whose `.env.example` mentions them, or of the back end's
   * folder. Returns the files written, relative to `root`.
   */
  writeEnv(root: string, info: DevDbInfo): string[] {
    if (!info.url || !info.port || !info.database || !info.user || !info.password) return [];
    const values: Record<string, string> = {
      DATABASE_URL: info.url,
      DB_HOST: "127.0.0.1",
      DB_PORT: String(info.port),
      DB_USER: info.user,
      DB_USERNAME: info.user,
      DB_PASSWORD: info.password,
      DB_NAME: info.database,
      DB_DATABASE: info.database,
      MYSQL_HOST: "127.0.0.1",
      MYSQL_PORT: String(info.port),
      MYSQL_USER: info.user,
      MYSQL_PASSWORD: info.password,
      MYSQL_DATABASE: info.database,
    };
    const written: string[] = [];
    for (const dir of envFolders(root)) {
      const envFile = path.join(dir, ".env");
      const example = [".env.example", ".env.sample", ".env.template"]
        .map((f) => path.join(dir, f))
        .find((f) => fs.existsSync(f));
      let text = fs.existsSync(envFile)
        ? fs.readFileSync(envFile, "utf8")
        : example
          ? fs.readFileSync(example, "utf8")
          : "";
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      let changed = false;
      for (const [k, v] of Object.entries(values)) {
        const re = new RegExp(`^${k}=.*$`, "m");
        if (re.test(text)) {
          const next = text.replace(re, `${k}=${v}`);
          changed ||= next !== text;
          text = next;
        } else if (k === "DATABASE_URL") {
          text = `${text}${text && !text.endsWith("\n") ? eol : ""}${k}=${v}${eol}`;
          changed = true;
        }
      }
      if (!changed && fs.existsSync(envFile)) continue;
      fs.writeFileSync(envFile, text);
      written.push(path.relative(root, envFile).split(path.sep).join("/"));
    }
    return written;
  }

  // ---- the portable MariaDB (Windows) ------------------------------------------------------

  /** Download and unpack the portable MariaDB once, after the owner allows it. */
  install(o: {
    projectId: string | null;
    taskId: string | null;
    agent: string;
    signal?: AbortSignal;
  }): Promise<DbBinaries> {
    if (this.platform !== "win32")
      return Promise.reject(
        new DevDbError(
          "No MySQL or MariaDB server is installed. Install MariaDB (for example `sudo apt install mariadb-server` or `brew install mariadb`) and try again.",
        ),
      );
    this.installing ??= this.download(o).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async download(o: {
    projectId: string | null;
    taskId: string | null;
    agent: string;
    signal?: AbortSignal;
  }): Promise<DbBinaries> {
    const ok = await this.o.approvals.request(
      {
        projectId: o.projectId,
        taskId: o.taskId,
        agent: o.agent,
        kind: "command",
        title: `Download MariaDB ${MARIADB_VERSION} (about 90 MB) for a local test database`,
        reason:
          "Depo runs a test database on this PC so the app can be tried with demo data. It comes from mariadb.org, is kept in Depo's data folder and only listens on 127.0.0.1.",
        details: { url: MARIADB_ZIP },
      },
      o.signal,
    );
    if (!ok) throw new DevDbError("The MariaDB download was not allowed, so there is no test database.");
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const dl = path.join(this.o.toolsDir, "downloads");
    const zip = path.join(dl, `mariadb-${MARIADB_VERSION}-winx64.zip`);
    this.o.bus.emit({
      agent: o.agent,
      projectId: o.projectId,
      taskId: o.taskId,
      type: "installing_dependency",
      text: `Downloading MariaDB ${MARIADB_VERSION} for the test database`,
      status: "started",
    });
    const res = await fetchImpl(MARIADB_ZIP, {
      headers: { "User-Agent": "Depo" },
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (!res.ok) throw new DevDbError(`mariadb.org answered ${res.status} for the MariaDB download.`);
    await writeStream(res, zip, MAX_ZIP);
    await this.verify(zip, fetchImpl);
    const dest = path.join(this.o.toolsDir, "mariadb");
    fs.mkdirSync(dest, { recursive: true });
    // Windows 10 and later ship bsdtar, which unpacks .zip (also large ones) quickly.
    const tar = await this.exec(["tar", "-xf", zip, "-C", dest], { timeoutMs: 600_000 });
    if (tar.exitCode !== 0)
      extractZip(zip, dest, { maxFiles: 20_000, maxTotalBytes: 2 * 1024 * 1024 * 1024 });
    fs.rmSync(zip, { force: true });
    const bins = this.binaries();
    if (!bins)
      throw new DevDbError("MariaDB was downloaded, but its programs were not found in the archive.");
    this.o.bus.emit({
      agent: o.agent,
      projectId: o.projectId,
      taskId: o.taskId,
      type: "installing_dependency",
      text: `MariaDB ${MARIADB_VERSION} is ready for test databases`,
      status: "succeeded",
    });
    return bins;
  }

  /** Check the download against mariadb.org's published checksums (skipped when they cannot be read). */
  private async verify(zip: string, fetchImpl: typeof fetch): Promise<void> {
    let sums = "";
    try {
      const r = await fetchImpl(MARIADB_SUMS, { headers: { "User-Agent": "Depo" } });
      if (r.ok) sums = await r.text();
    } catch {
      sums = "";
    }
    const want = new RegExp(
      `^([0-9a-f]{64})\\s+\\*?${path.basename(zip).replace(/\./g, "\\.")}\\s*$`,
      "im",
    ).exec(sums)?.[1];
    if (!want) {
      this.log.warn("MariaDB checksum not available; download kept unverified");
      return;
    }
    const hasher = new Bun.CryptoHasher("sha256");
    const file = Bun.file(zip);
    const stream = file.stream();
    for await (const chunk of stream) hasher.update(chunk);
    const got = hasher.digest("hex");
    if (got.toLowerCase() !== want.toLowerCase()) {
      fs.rmSync(zip, { force: true });
      throw new DevDbError("The MariaDB download is damaged (its checksum does not match). Try again.");
    }
  }

  // ---- processes ---------------------------------------------------------------------------

  private childEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !/^(DEPO_|MYSQL_PWD$)/.test(k)) env[k] = v;
    return { ...env, ...extra };
  }

  private client(
    bins: DbBinaries,
    port: number,
    who: { user: string; password?: string; database?: string; table?: boolean },
    sql: string,
    timeoutMs = SQL_TIMEOUT_MS,
  ): Promise<{ exitCode: number | null; output: string }> {
    const argv = [
      bins.client,
      "--no-defaults",
      "--protocol=TCP",
      "-h127.0.0.1",
      `-P${port}`,
      `-u${who.user}`,
      who.table ? "--table" : "--batch",
      ...(who.database ? [who.database] : []),
      "-e",
      sql,
    ];
    return this.exec(argv, { timeoutMs, env: who.password ? { MYSQL_PWD: who.password } : {} });
  }

  private async exec(
    argv: string[],
    o: { timeoutMs: number; env?: Record<string, string> },
  ): Promise<{ exitCode: number | null; output: string }> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: this.childEnv(o.env),
      });
    } catch (err) {
      return { exitCode: null, output: err instanceof Error ? err.message : String(err) };
    }
    const timer = setTimeout(() => proc.kill(), o.timeoutMs);
    try {
      const [out, errText, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      return { exitCode: code, output: `${out}${errText ? `${out ? "\n" : ""}${errText}` : ""}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}

const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".depo",
  ".venv",
  "venv",
  "__pycache__",
]);
const DB_KEYS = /^(DATABASE_URL|DB_HOST|DB_NAME|DB_DATABASE|MYSQL_HOST|MYSQL_DATABASE)=/m;
const BACKEND_DIRS = ["be", "backend", "server", "api"];

/** Folders whose `.env` should point at the test database. */
export function envFolders(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const mentions = entries.some((e) => {
      if (!e.isFile() || !/^\.env(\.example|\.sample|\.template)?$/.test(e.name)) return false;
      try {
        return DB_KEYS.test(fs.readFileSync(path.join(dir, e.name), "utf8"));
      } catch {
        return false;
      }
    });
    if (mentions) out.push(dir);
    if (depth < 2)
      for (const e of entries)
        if (e.isDirectory() && !SKIP.has(e.name)) visit(path.join(dir, e.name), depth + 1);
  };
  visit(root, 0);
  if (out.length) return out;
  const be = BACKEND_DIRS.map((d) => path.join(root, d)).find(
    (d) =>
      fs.existsSync(path.join(d, "package.json")) ||
      fs.existsSync(path.join(d, "pyproject.toml")) ||
      fs.existsSync(path.join(d, "requirements.txt")),
  );
  if (be) return [be];
  return fs.existsSync(path.join(root, "package.json")) || fs.existsSync(path.join(root, "pyproject.toml"))
    ? [root]
    : [];
}
