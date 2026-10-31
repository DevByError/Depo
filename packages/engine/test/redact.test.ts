import { describe, expect, test } from "bun:test";
import { REDACTED, redact, redactString } from "../src/redact";

describe("redaction", () => {
  test("redacts .env style secrets but keeps other lines", () => {
    const env = "PORT=3000\nDATABASE_PASSWORD=hunter2\nAPI_KEY = abc123\nexport GITHUB_TOKEN=xyz";
    expect(redactString(env)).toBe(
      `PORT=3000\nDATABASE_PASSWORD=${REDACTED}\nAPI_KEY = ${REDACTED}\nexport GITHUB_TOKEN=${REDACTED}`,
    );
  });
  test("redacts bearer tokens, JWTs and GitHub tokens", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnop")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactString("tok ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(`tok ${REDACTED}`);
    expect(redactString("jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2Q")).toBe(`jwt ${REDACTED}`);
  });
  test("redacts secret-looking keys in objects, recursively", () => {
    expect(
      redact({ user: "a", password: "p", nested: { apiKey: "k", list: ["Bearer 123456789abc"] } }),
    ).toEqual({
      user: "a",
      password: REDACTED,
      nested: { apiKey: REDACTED, list: [`Bearer ${REDACTED}`] },
    });
  });
});

test("redacts cmd, PowerShell and inline assignments", () => {
  expect(redactString("set DB_PASSWORD=abc")).toBe(`set DB_PASSWORD=${REDACTED}`);
  expect(redactString('$env:OPENAI_API_KEY = "abc"')).toBe(`$env:OPENAI_API_KEY = ${REDACTED}`);
  expect(redactString("SECRET_TOKEN=abc npm start")).toBe(`SECRET_TOKEN=${REDACTED}`);
  expect(redactString("run with AUTH_TOKEN=abc then PORT=3000")).toBe(
    `run with AUTH_TOKEN=${REDACTED} then PORT=3000`,
  );
  expect(redactString("PORT=3000 node server.js")).toBe("PORT=3000 node server.js");
});

test("secret names are matched by word, not substring", async () => {
  const { isSecretName } = await import("../src/redact");
  for (const yes of [
    "GITHUB_TOKEN",
    "dbPassword",
    "api-key",
    "API_KEY",
    "x-auth",
    "sessionId",
    "PASS",
    "clientSecret",
  ]) {
    expect(isSecretName(yes)).toBe(true);
  }
  for (const no of [
    "passed",
    "completionTokens",
    "bypass",
    "tokensPerSec",
    "author",
    "keyboard",
    "passing",
  ]) {
    expect(isSecretName(no)).toBe(false);
  }
});
