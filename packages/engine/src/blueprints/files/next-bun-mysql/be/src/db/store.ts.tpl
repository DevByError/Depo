/**
 * Where users and sessions live. The MySQL store is the real one; the memory store backs the
 * tests and a quick try without a database. Both behave the same.
 */

export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

export interface Session {
  /** SHA-256 of the token in the cookie (the token itself is never stored). */
  id: string;
  userId: number;
  expiresAt: Date;
}

export interface Store {
  readonly kind: "mysql" | "memory";
  /** Throws EmailTakenError when the email is already registered. */
  createUser(input: { name: string; email: string; passwordHash: string }): Promise<User>;
  findUserByEmail(email: string): Promise<UserWithHash | null>;
  findUserById(id: number): Promise<User | null>;
  createSession(session: Session): Promise<void>;
  findSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<number>;
  close(): Promise<void>;
}

export class EmailTakenError extends Error {
  constructor() {
    super("This email is already registered.");
    this.name = "EmailTakenError";
  }
}
