import { describe, expect, test } from "bun:test";
import { parseTestOutput, relFile } from "../src/terminal/test-parsers";

/** Real output of each runner (captured from the tools), with paths made portable. */

const lines = (...l: string[]) => l.join("\n");

const PYTEST = lines(
  "F.F                                                                      [100%]",
  "=================================== FAILURES ===================================",
  "___________________________________ test_add ___________________________________",
  "",
  "    def test_add():",
  ">       assert add(2, 2) == 4",
  "E       assert 0 == 4",
  "E        +  where 0 = add(2, 2)",
  "",
  "tests/test_calc.py:4: AssertionError",
  "___________________________________ test_err ___________________________________",
  "",
  "    def test_err():",
  '>       raise ValueError("boom")',
  "E       ValueError: boom",
  "",
  "tests/test_calc.py:10: ValueError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_calc.py::test_add - assert 0 == 4",
  "FAILED tests/test_calc.py::test_err - ValueError: boom",
  "2 failed, 1 passed in 0.02s",
);

const UNITTEST = lines(
  "FE.",
  "======================================================================",
  "ERROR: test_err (tests.test_unit.T.test_err)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  '  File "C:\\Users\\Me\\My App\\tests\\test_unit.py", line 12, in test_err',
  '    raise KeyError("k")',
  "KeyError: 'k'",
  "",
  "======================================================================",
  "FAIL: test_add (tests.test_unit.T.test_add)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  '  File "C:\\Users\\Me\\My App\\tests\\test_unit.py", line 6, in test_add',
  "    self.assertEqual(add(2, 2), 4)",
  "    ~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^",
  "AssertionError: 0 != 4",
  "",
  "----------------------------------------------------------------------",
  "Ran 3 tests in 0.001s",
  "",
  "FAILED (failures=1, errors=1)",
);

const VITEST = lines(
  " RUN  v5.0.5 C:/Users/Me/My App",
  "",
  " ❯ src/math.test.ts (2 tests | 1 failed) 10ms",
  "   × adds 7ms",
  "",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  src/math.test.ts > adds",
  "AssertionError: expected 2 to be 3 // Object.is equality",
  "",
  "- Expected",
  "+ Received",
  "",
  "- 3",
  "+ 2",
  "",
  " ❯ src/math.test.ts:4:17",
  "      2|",
  '      3| test("adds", () => {',
  "      4|   expect(1 + 1).toBe(3);",
  "       |                 ^",
  "      5| });",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
  "",
  " Test Files  1 failed (1)",
  "      Tests  1 failed | 1 passed (2)",
  "   Start at  07:09:28",
);

const JEST = lines(
  "FAIL src/math.test.js",
  "  math",
  "    ✕ adds (3 ms)",
  "    ✓ ok (1 ms)",
  "",
  "  ● math › adds",
  "",
  "    expect(received).toBe(expected) // Object.is equality",
  "",
  "    Expected: 3",
  "    Received: 2",
  "",
  "      2 |",
  '      3 | test("adds", () => {',
  "    > 4 |   expect(1 + 1).toBe(3);",
  "        |                 ^",
  "      5 | });",
  "",
  "      at Object.toBe (src/math.test.js:4:17)",
  "",
  "Test Suites: 1 failed, 1 total",
  "Tests:       1 failed, 1 passed, 2 total",
  "Time:        0.5 s",
);

const BUN = lines(
  "bun test v1.4.4 (38afee6c8)",
  "",
  "math.test.ts:",
  '1 | import { expect, test } from "bun:test";',
  "2 | ",
  '3 | test("adds", () => {',
  "4 |   expect(1 + 1).toBe(3);",
  "                    ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 3",
  "Received: 2",
  "",
  "      at <anonymous> (/home/me/my app/math.test.ts:4:17)",
  "(fail) adds [0.42ms]",
  "(pass) ok",
  "",
  " 1 pass",
  " 1 fail",
  " 2 expect() calls",
  "Ran 2 tests across 1 file. [4.00ms]",
);

const GO = lines(
  "--- FAIL: TestAdd (0.00s)",
  "    main_test.go:7: got 2, want 3",
  "FAIL",
  "FAIL\texample.com/demo\t0.002s",
  "ok  \texample.com/demo/sub\t0.001s",
  "FAIL",
);

const GO_VERBOSE = lines(
  "=== RUN   TestAdd",
  "    main_test.go:7: got 2, want 3",
  "--- FAIL: TestAdd (0.00s)",
  "=== RUN   TestOk",
  "--- PASS: TestOk (0.00s)",
  "FAIL",
  "FAIL\texample.com/demo\t0.002s",
);

const CARGO = lines(
  "running 2 tests",
  "test tests::ok ... ok",
  "test tests::adds ... FAILED",
  "",
  "failures:",
  "",
  "---- tests::adds stdout ----",
  "",
  "thread 'tests::adds' (9313) panicked at src/lib.rs:7:17:",
  "assertion `left == right` failed",
  "  left: 0",
  " right: 4",
  "stack backtrace:",
  "   0: __rustc::rust_begin_unwind",
  "",
  "failures:",
  "    tests::adds",
  "",
  "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s",
);

describe("test output parsers", () => {
  test("pytest: failures with file, line and the E lines; counts from the summary", () => {
    const r = parseTestOutput(PYTEST);
    expect(r).toMatchObject({
      format: "pytest",
      passed: 1,
      failed: 2,
      summary: "2 failed, 1 passed in 0.02s",
    });
    expect(r.failures).toEqual([
      {
        name: "tests/test_calc.py::test_add",
        file: "tests/test_calc.py",
        line: 4,
        message: "assert 0 == 4\n +  where 0 = add(2, 2)",
      },
      {
        name: "tests/test_calc.py::test_err",
        file: "tests/test_calc.py",
        line: 10,
        message: "ValueError: boom",
      },
    ]);
  });

  test("unittest: FAIL and ERROR blocks, Windows paths made relative to the root", () => {
    const r = parseTestOutput(UNITTEST, "C:\\Users\\Me\\My App");
    expect(r).toMatchObject({ format: "unittest", passed: 1, failed: 2 });
    expect(r.failures).toEqual([
      { name: "tests.test_unit.T.test_err", file: "tests/test_unit.py", line: 12, message: "KeyError: 'k'" },
      {
        name: "tests.test_unit.T.test_add",
        file: "tests/test_unit.py",
        line: 6,
        message: "AssertionError: 0 != 4",
      },
    ]);
  });

  test("vitest and jest: the failing test, where it failed and the assertion text", () => {
    const v = parseTestOutput(VITEST);
    expect(v).toMatchObject({ format: "vitest", passed: 1, failed: 1 });
    expect(v.failures[0]).toMatchObject({
      name: "src/math.test.ts > adds",
      file: "src/math.test.ts",
      line: 4,
    });
    expect(v.failures[0]?.message).toContain("expected 2 to be 3");

    const j = parseTestOutput(JEST);
    expect(j).toMatchObject({ format: "jest", passed: 1, failed: 1 });
    expect(j.failures).toHaveLength(1);
    expect(j.failures[0]).toMatchObject({ name: "math › adds", file: "src/math.test.js", line: 4 });
    expect(j.failures[0]?.message).toContain("Expected: 3");
    expect(j.failures[0]?.message).not.toContain("|");
  });

  test("bun test: the failing test and its frame, with a path that has a space", () => {
    const r = parseTestOutput(BUN, "/home/me/my app");
    expect(r).toMatchObject({ format: "bun", passed: 1, failed: 1, summary: "1 pass, 1 fail" });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ name: "adds", file: "math.test.ts", line: 4 });
    expect(r.failures[0]?.message).toContain("error: expect(received).toBe(expected)");
  });

  test("go test: log lines after the FAIL line (plain) or before it (-v)", () => {
    const r = parseTestOutput(GO);
    expect(r).toMatchObject({ format: "go", failed: 1, summary: "1 package ok, 1 failed" });
    expect(r.failures[0]).toEqual({
      name: "TestAdd",
      file: "main_test.go",
      line: 7,
      message: "got 2, want 3",
    });
    const v = parseTestOutput(GO_VERBOSE);
    expect(v).toMatchObject({ passed: 1, failed: 1 });
    expect(v.failures[0]).toEqual({
      name: "TestAdd",
      file: "main_test.go",
      line: 7,
      message: "got 2, want 3",
    });
  });

  test("cargo test: the panic location and message", () => {
    const r = parseTestOutput(CARGO);
    expect(r).toMatchObject({ format: "cargo", passed: 1, failed: 1 });
    expect(r.failures[0]).toMatchObject({ name: "tests::adds", file: "src/lib.rs", line: 7 });
    expect(r.failures[0]?.message).toContain("assertion `left == right` failed");
    expect(r.failures[0]?.message).not.toContain("stack backtrace");
  });

  test("unknown output falls back to the summary, or nothing", () => {
    expect(parseTestOutput("Tests: 2 failed, 5 passed")).toMatchObject({
      format: null,
      passed: 5,
      failed: 2,
      failures: [],
    });
    expect(parseTestOutput("all good")).toEqual({
      format: null,
      passed: null,
      failed: null,
      summary: null,
      failures: [],
    });
    expect(parseTestOutput("\x1b[31m(fail) red [1ms]\x1b[0m").failures[0]?.name).toBe("red");
  });

  test("paths: absolute paths inside the root become relative; others keep forward slashes", () => {
    expect(relFile("C:\\Proj\\src\\a.ts", "c:\\proj")).toBe("src/a.ts");
    expect(relFile("file:///C:/Proj/src/a.ts", "C:\\Proj")).toBe("src/a.ts");
    expect(relFile("./tests/x.py")).toBe("tests/x.py");
    expect(relFile("/other/place/x.py", "/proj")).toBe("/other/place/x.py");
  });
});
