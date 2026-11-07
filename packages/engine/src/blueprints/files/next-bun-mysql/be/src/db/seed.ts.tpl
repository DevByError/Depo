import { hashPassword } from "../auth/password";
import { mysqlStore } from "./mysql";
import { EmailTakenError, type Store } from "./store";

/** Demo accounts for trying the app. Never seed these into a production database. */
export const DEMO_USERS = [
  { name: "Demo User", email: "demo@example.com", password: "demo12345" },
  { name: "Ada Lovelace", email: "ada@example.com", password: "ada12345" },
  { name: "Alan Turing", email: "alan@example.com", password: "alan12345" },
];

/** Add the demo users that are not there yet. Returns the emails added. */
export async function seed(store: Store): Promise<string[]> {
  const added: string[] = [];
  for (const u of DEMO_USERS) {
    if (await store.findUserByEmail(u.email)) continue;
    try {
      await store.createUser({ name: u.name, email: u.email, passwordHash: await hashPassword(u.password) });
      added.push(u.email);
    } catch (err) {
      if (!(err instanceof EmailTakenError)) throw err;
    }
  }
  return added;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("Set DATABASE_URL in be/.env first, then run: bun run db:migrate");
    process.exit(1);
  }
  const store = mysqlStore(url);
  try {
    const added = await seed(store);
    console.log(added.length ? `Added demo users: ${added.join(", ")}` : "Demo users are already there.");
    for (const u of DEMO_USERS) console.log(`  ${u.email} / ${u.password}`);
  } finally {
    await store.close();
  }
}
