import { describe, expect, test } from "bun:test";
import { displayPath, resolveDataRoot, toLongPath } from "../src/paths";

describe("resolveDataRoot", () => {
  test("uses %LOCALAPPDATA%\\Depo on Windows", () => {
    expect(resolveDataRoot({ LOCALAPPDATA: "C:\\Users\\Zoë Ali\\AppData\\Local" }, "win32")).toBe(
      "C:\\Users\\Zoë Ali\\AppData\\Local\\Depo",
    );
  });
  test("falls back to USERPROFILE when LOCALAPPDATA is missing", () => {
    expect(resolveDataRoot({ USERPROFILE: "D:\\Users\\محمد" }, "win32")).toBe(
      "D:\\Users\\محمد\\AppData\\Local\\Depo",
    );
  });
  test("DEPO_DATA_DIR overrides", () => {
    expect(resolveDataRoot({ DEPO_DATA_DIR: "/tmp/x", LOCALAPPDATA: "C:\\L" }, "linux")).toBe("/tmp/x");
    expect(resolveDataRoot({ DEPO_DATA_DIR: "D:\\Depo Data", LOCALAPPDATA: "C:\\L" }, "win32")).toBe(
      "D:\\Depo Data",
    );
  });
});

describe("toLongPath", () => {
  const long = `C:\\Projects\\${"very long folder name\\".repeat(14)}file.ts`;
  test("prefixes long Windows paths", () => {
    expect(long.length).toBeGreaterThan(260);
    expect(toLongPath(long, "win32")).toBe(`\\\\?\\${long}`);
  });
  test("handles UNC shares", () => {
    const unc = `\\\\server\\share\\${"x".repeat(260)}`;
    expect(toLongPath(unc, "win32")).toBe(`\\\\?\\UNC\\server\\share\\${"x".repeat(260)}`);
  });
  test("leaves short paths and non-Windows paths alone", () => {
    expect(toLongPath("C:\\a\\b.txt", "win32")).toBe("C:\\a\\b.txt");
    expect(toLongPath(`/${"a".repeat(300)}`, "linux")).toBe(`/${"a".repeat(300)}`);
  });
  test("is idempotent and displays without the prefix", () => {
    const once = toLongPath(long, "win32");
    expect(toLongPath(once, "win32")).toBe(once);
    expect(displayPath(once, "win32")).toBe(long);
  });
});
