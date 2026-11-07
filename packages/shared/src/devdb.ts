import { z } from "zod";

/** The project's test database: MariaDB (or an installed MySQL) that Depo runs on 127.0.0.1. */
export const DevDbInfoSchema = z.object({
  projectId: z.string(),
  /** missing: no server on this PC (outside Windows, where Depo can download MariaDB). */
  state: z.enum(["missing", "stopped", "starting", "running", "failed"]),
  engine: z.enum(["mariadb", "mysql"]).nullable(),
  version: z.string().nullable(),
  port: z.number().int().nullable(),
  database: z.string().nullable(),
  user: z.string().nullable(),
  password: z.string().nullable(),
  /** mysql://user:password@127.0.0.1:port/database */
  url: z.string().nullable(),
  dataDir: z.string().nullable(),
  /** Why it failed, in plain words. */
  message: z.string().nullable(),
});
export type DevDbInfo = z.infer<typeof DevDbInfoSchema>;

const ProjectParams = z.object({ projectId: z.string().min(1).max(64) }).strict();

export const DevDbMethods = {
  "devdb.status": { params: ProjectParams, result: DevDbInfoSchema },
  /** Create (the first time) and start the test database. */
  "devdb.start": { params: ProjectParams, result: DevDbInfoSchema },
  "devdb.stop": { params: ProjectParams, result: z.object({ stopped: z.boolean() }) },
  /** Drop every table; the user and password stay. */
  "devdb.reset": { params: ProjectParams, result: DevDbInfoSchema },
} as const;
