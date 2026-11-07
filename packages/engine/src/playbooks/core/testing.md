## Definition of done
- The project's full test command runs and passes; the exact command and the counts are in reviews/test-report.md, with what is covered and the known gaps.
- Every acceptance criterion of the plan has at least one test that would fail if the behaviour broke.
- API tests per route: success, validation error, unauthenticated (401), forbidden (403) where roles exist, not found (404), and conflicts (409) where the rules allow them.
- At least one end-to-end test walks the main user story through the real UI when a UI exists (Playwright), including sign-in when the app has users.
- Tests are isolated (own test database or transaction rollback, no network, no shared state between tests) and deterministic (fixed clock and seeds).
- Flaky tests are reported with the cause, never hidden.

## Checklist
- Find the runner first: package.json scripts, pytest config, Makefile, CI workflow.
- Read the failure, find the cause in the code, fix it, run again. Fix the test only when the test is wrong, and say why.
- Use factories or fixtures for data; name tests after behaviour ("rejects a booking that overlaps").
- Query UI elements by role and label, wait for conditions (never fixed sleeps).
- Add a regression test for every bug fixed.

## Avoid
- Weakening assertions, skipping or deleting tests to get green.
- Tests that only check "status 200" without the body or the state change.
- Mocking the unit under test; snapshot tests as the only check.
- Tests that depend on run order or on the developer's machine.
