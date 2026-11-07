/** Settings from the environment (Bun loads .env by itself). */
export interface Config {
  port: number;
  host: string;
  /** mysql://user:password@host:port/database, or null to keep data in memory. */
  databaseUrl: string | null;
  /** The web app's origin, allowed to call the API with cookies (CORS). */
  webOrigin: string;
  /** Production: the session cookie is Secure (HTTPS only). */
  production: boolean;
  /** How long a sign-in lasts. */
  sessionDays: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT ?? 4000);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4000,
    host: env.HOST?.trim() || "127.0.0.1",
    databaseUrl: env.DATABASE_URL?.trim() || null,
    webOrigin: env.WEB_ORIGIN?.trim() || "http://localhost:3000",
    production: env.NODE_ENV === "production",
    sessionDays: 7,
  };
}
