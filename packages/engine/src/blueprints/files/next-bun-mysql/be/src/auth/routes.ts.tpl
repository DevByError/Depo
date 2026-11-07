import type { Config } from "../config";
import { EmailTakenError, type Store, type User } from "../db/store";
import { fail, json, readJson } from "../http";
import type { Limiter } from "../limiter";
import { hashPassword, verifyPassword } from "./password";
import { clearedCookie, newToken, readCookie, SESSION_COOKIE, sessionCookie, sessionIdOf } from "./sessions";
import { checkLogin, checkRegister } from "./validate";

export interface AuthDeps {
  store: Store;
  config: Config;
  limiter: Limiter;
}

/** A hash to compare against when the email is unknown, so both cases take the same time. */
let dummyHash: Promise<string> | null = null;

async function startSession(deps: AuthDeps, user: User, status: number): Promise<Response> {
  const token = newToken();
  const maxAge = deps.config.sessionDays * 24 * 60 * 60;
  await deps.store.createSession({
    id: sessionIdOf(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });
  return json(status, { user }, { "set-cookie": sessionCookie(token, maxAge, deps.config.production) });
}

/** The signed-in user for this request, or null. */
export async function currentUser(deps: AuthDeps, req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = await deps.store.findSession(sessionIdOf(token));
  if (!session) return null;
  if (session.expiresAt <= new Date()) {
    await deps.store.deleteSession(session.id);
    return null;
  }
  return deps.store.findUserById(session.userId);
}

export async function register(deps: AuthDeps, req: Request): Promise<Response> {
  const checked = checkRegister(await readJson(req));
  if (!checked.ok) return fail(400, "invalid", "Please fix the highlighted fields.", checked.fields);
  const { name, email, password } = checked.value;
  try {
    const user = await deps.store.createUser({ name, email, passwordHash: await hashPassword(password) });
    return startSession(deps, user, 201);
  } catch (err) {
    if (err instanceof EmailTakenError)
      return fail(409, "email_taken", "This email is already registered. Sign in instead.", {
        email: "This email is already registered.",
      });
    throw err;
  }
}

export async function login(deps: AuthDeps, req: Request, client: string): Promise<Response> {
  const checked = checkLogin(await readJson(req));
  if (!checked.ok) return fail(400, "invalid", "Please fix the highlighted fields.", checked.fields);
  const { email, password } = checked.value;
  const key = `${client}|${email}`;
  if (!deps.limiter.take(key))
    return fail(429, "too_many_attempts", "Too many attempts. Wait a few minutes and try again.");
  const user = await deps.store.findUserByEmail(email);
  dummyHash ??= hashPassword("not-a-real-password");
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok) return fail(401, "bad_credentials", "The email or password is not right.");
  deps.limiter.reset(key);
  const { passwordHash: _hash, ...publicUser } = user;
  return startSession(deps, publicUser, 200);
}

export async function logout(deps: AuthDeps, req: Request): Promise<Response> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await deps.store.deleteSession(sessionIdOf(token));
  return json(204, null, { "set-cookie": clearedCookie(deps.config.production) });
}

/** The signed-in user, or { user: null } (not an error: a signed-out visitor is normal). */
export async function me(deps: AuthDeps, req: Request): Promise<Response> {
  return json(200, { user: await currentUser(deps, req) });
}
