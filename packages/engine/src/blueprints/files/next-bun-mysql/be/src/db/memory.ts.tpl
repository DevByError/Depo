import { EmailTakenError, type Session, type Store, type User, type UserWithHash } from "./store";

/** Users and sessions in memory: for tests, and for a quick try without a database. */
export function memoryStore(): Store {
  const users = new Map<number, UserWithHash>();
  const sessions = new Map<string, Session>();
  let nextId = 1;
  const publicUser = ({ passwordHash: _hash, ...u }: UserWithHash): User => u;
  return {
    kind: "memory",
    async createUser(input) {
      const email = input.email.toLowerCase();
      for (const u of users.values()) if (u.email === email) throw new EmailTakenError();
      const user: UserWithHash = {
        id: nextId++,
        name: input.name,
        email,
        passwordHash: input.passwordHash,
        createdAt: new Date().toISOString(),
      };
      users.set(user.id, user);
      return publicUser(user);
    },
    async findUserByEmail(email) {
      const e = email.toLowerCase();
      for (const u of users.values()) if (u.email === e) return { ...u };
      return null;
    },
    async findUserById(id) {
      const u = users.get(id);
      return u ? publicUser(u) : null;
    },
    async createSession(s) {
      sessions.set(s.id, { ...s });
    },
    async findSession(id) {
      const s = sessions.get(id);
      return s ? { ...s } : null;
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async deleteExpiredSessions(now) {
      let n = 0;
      for (const [id, s] of sessions) {
        if (s.expiresAt <= now) {
          sessions.delete(id);
          n++;
        }
      }
      return n;
    },
    async close() {},
  };
}
