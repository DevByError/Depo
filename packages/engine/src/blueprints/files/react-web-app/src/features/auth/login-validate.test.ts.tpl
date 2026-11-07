import { expect, test } from "vitest";
import { validateLogin } from "./login-validate";

test("empty fields explain what to do", () => {
  expect(validateLogin("", "")).toEqual({ email: "Enter your email address.", password: "Enter your password." });
});

test("a malformed email is explained and a good one passes", () => {
  expect(validateLogin("nope", "x").email).toContain("valid email");
  expect(validateLogin(" a@b.co ", "x")).toEqual({});
});
