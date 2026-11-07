/**
 * Stands in for Edge or Chrome in launch tests: reads --user-data-dir, serves a fake DevTools
 * endpoint and announces it the way a real browser does. FAKE_BROWSER_MODE picks the behaviour:
 *   normal  write DevToolsActivePort, exit on Browser.close
 *   stderr  announce on stderr ("DevTools listening on ws://…") instead of the file
 *   hang    ignore Browser.close, so the caller must kill the process
 *   crash   print an error and exit before it is ready
 */
import fs from "node:fs";
import path from "node:path";
import { startFakeCdp } from "../fake-cdp";

const mode = process.env.FAKE_BROWSER_MODE ?? "normal";
const profile = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!profile) {
  console.error("no --user-data-dir");
  process.exit(2);
}
if (mode === "crash") {
  console.error("[0101/000000.000:FATAL:browser_main.cc] Something went badly wrong");
  process.exit(3);
}
// Leave something in the profile, like a real browser does.
fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
fs.writeFileSync(path.join(profile, "Default", "Preferences"), "{}");
const fake = startFakeCdp({
  ignoreClose: mode === "hang",
  onClose: () => setTimeout(() => process.exit(0), 20),
});
const wsPath = new URL(fake.url).pathname;
if (mode === "stderr") console.error(`\nDevTools listening on ${fake.url}\n`);
else fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${fake.port}\n${wsPath}`);
if (process.env.FAKE_BROWSER_PIDFILE) fs.writeFileSync(process.env.FAKE_BROWSER_PIDFILE, String(process.pid));
// Stay alive until closed or killed.
setInterval(() => {}, 1 << 30);
