#!/usr/bin/env sh
# Run every test and type check on macOS or Linux.
set -eu
cd "$(dirname "$0")"
(cd be && bun test && bun run typecheck)
(cd fe && bun test lib && bun run typecheck)
echo "All tests passed."
