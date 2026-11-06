import { afterEach, expect, test } from "bun:test";
import { checkForUpdate, compareVersions } from "../src/util/update";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

function fakeGithub(handler: (path: string) => Response) {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler(new URL(req.url).pathname) });
  return `http://127.0.0.1:${server.port}`;
}

test("versions compare like semver, ignoring a leading v and putting pre-releases first", () => {
  expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
  expect(compareVersions("v0.2.0", "0.10.0")).toBeLessThan(0);
  expect(compareVersions("1.0.0", "1.0")).toBe(0);
  expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
});

test("a newer release is reported with its page; the same or an older one is not", async () => {
  const api = fakeGithub((p) =>
    p === "/repos/acme/depo/releases/latest"
      ? Response.json({
          tag_name: "v0.3.0",
          html_url: "https://github.com/acme/depo/releases/tag/v0.3.0",
          body: "Notes",
        })
      : new Response("no", { status: 404 }),
  );
  const a = await checkForUpdate({ current: "0.2.0", repo: "acme/depo", api });
  expect(a).toMatchObject({
    status: "available",
    latest: "0.3.0",
    url: "https://github.com/acme/depo/releases/tag/v0.3.0",
    notes: "Notes",
  });
  expect((await checkForUpdate({ current: "0.3.0", repo: "acme/depo", api })).status).toBe("up_to_date");
  expect((await checkForUpdate({ current: "1.0.0", repo: "acme/depo", api })).status).toBe("up_to_date");
});

test("not configured, bad repository names, no release, server errors and unreachable servers are explained", async () => {
  expect((await checkForUpdate({ current: "0.1.0", repo: "" })).status).toBe("unconfigured");
  const bad = await checkForUpdate({ current: "0.1.0", repo: "../../etc/passwd" });
  expect(bad).toMatchObject({ status: "error", message: "The repository must look like owner/name." });
  const api = fakeGithub((p) =>
    p.includes("none") ? new Response("", { status: 404 }) : new Response("", { status: 500 }),
  );
  expect((await checkForUpdate({ current: "0.1.0", repo: "a/none", api })).message).toContain(
    "no published release",
  );
  expect((await checkForUpdate({ current: "0.1.0", repo: "a/b", api })).message).toContain("500");
  const dead = await checkForUpdate({
    current: "0.1.0",
    repo: "a/b",
    api: "http://127.0.0.1:1",
    timeoutMs: 1500,
  });
  expect(dead.status).toBe("error");
  expect(dead.message).toContain("Could not reach GitHub");
});

test("a release page that is not https falls back to the releases list", async () => {
  const api = fakeGithub(() => Response.json({ tag_name: "9.0.0", html_url: "javascript:alert(1)" }));
  const r = await checkForUpdate({ current: "0.1.0", repo: "a/b", api });
  expect(r.url).toBe("https://github.com/a/b/releases");
  const draft = fakeGithub(() => Response.json({ tag_name: "9.0.0", draft: true }));
  expect((await checkForUpdate({ current: "0.1.0", repo: "a/b", api: draft })).status).toBe("error");
});
