import mysql, { type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { EmailTakenError, type Store, type User, type UserWithHash } from "./store";

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

interface SessionRow extends RowDataPacket {
  id: string;
  user_id: number;
  expires_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: Number(r.id),
  name: r.name,
  email: r.email,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Users and sessions in MySQL or MariaDB (tables from schema.sql: bun run db:migrate). */
export function mysqlStore(url: string): Store {
  const pool = mysql.createPool({ uri: url, connectionLimit: 10, timezone: "Z", supportBigNumbers: true });
  const findUserById = async (id: number): Promise<User | null> => {
    const [rows] = await pool.execute<UserRow[]>(
      "SELECT id, name, email, password_hash, created_at FROM users WHERE id = ?",
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  };
  return {
    kind: "mysql",
    async createUser(input) {
      try {
        const [res] = await pool.execute<ResultSetHeader>(
          "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
          [input.name, input.email.toLowerCase(), input.passwordHash],
        );
        const user = await findUserById(Number(res.insertId));
        if (!user) throw new Error("The new user could not be read back.");
        return user;
      } catch (err) {
        if ((err as { code?: string }).code === "ER_DUP_ENTRY") throw new EmailTakenError();
        throw err;
      }
    },
    async findUserByEmail(email) {
      const [rows] = await pool.execute<UserRow[]>(
        "SELECT id, name, email, password_hash, created_at FROM users WHERE email = ?",
        [email.toLowerCase()],
      );
      const r = rows[0];
      return r ? ({ ...toUser(r), passwordHash: r.password_hash } satisfies UserWithHash) : null;
    },
    findUserById,
    async createSession(s) {
      await pool.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [
        s.id,
        s.userId,
        s.expiresAt,
      ]);
    },
    async findSession(id) {
      const [rows] = await pool.execute<SessionRow[]>(
        "SELECT id, user_id, expires_at FROM sessions WHERE id = ?",
        [id],
      );
      const r = rows[0];
      return r ? { id: r.id, userId: Number(r.user_id), expiresAt: new Date(r.expires_at) } : null;
    },
    async deleteSession(id) {
      await pool.execute("DELETE FROM sessions WHERE id = ?", [id]);
    },
    async deleteExpiredSessions(now) {
      const [res] = await pool.execute<ResultSetHeader>("DELETE FROM sessions WHERE expires_at <= ?", [now]);
      return res.affectedRows;
    },
    async close() {
      await pool.end();
    },
  };
}
