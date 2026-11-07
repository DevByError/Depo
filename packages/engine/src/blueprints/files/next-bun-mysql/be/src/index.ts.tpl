import { createApp } from "./app";
import { loadConfig } from "./config";
import { memoryStore } from "./db/memory";
import { mysqlStore } from "./db/mysql";

const config = loadConfig();
const store = config.databaseUrl ? mysqlStore(config.databaseUrl) : memoryStore();
if (store.kind === "memory")
  console.warn("No DATABASE_URL in be/.env: users are kept in memory and lost when the API stops.");

const app = createApp({ store, config });
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: (req, srv) => app.fetch(req, srv),
});
console.log(`API ready on http://${server.hostname}:${server.port} (store: ${store.kind})`);

// Remove expired sessions every hour.
setInterval(() => void store.deleteExpiredSessions(new Date()).catch(console.error), 60 * 60_000);

const stop = async () => {
  server.stop();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
