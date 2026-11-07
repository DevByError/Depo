import { describe, expect, test } from "bun:test";
import { checkLoginForm, checkRegisterForm, initials } from "./validate";

describe("form checks", () => {
  test("sign up needs a name, a valid email and 8 characters", () => {
    expect(checkRegisterForm({ name: "", email: "x", password: "1" })).toEqual({
      name: "Enter your name.",
      email: "Enter a valid email address.",
      password: "Use at least 8 characters.",
    });
    expect(checkRegisterForm({ name: "Sam", email: "sam@example.com", password: "secret123" })).toEqual({});
  });

  test("sign in needs both fields", () => {
    expect(Object.keys(checkLoginForm({ email: "", password: "" }))).toEqual(["email", "password"]);
    expect(checkLoginForm({ email: "a@b.co", password: "x" })).toEqual({});
  });

  test("initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("sam")).toBe("S");
    expect(initials("  ")).toBe("?");
  });
});
