#!/usr/bin/env sh
# Start the API and the web app on macOS or Linux; Ctrl+C stops both. Run every test with: ./test.sh
set -eu
cd "$(dirname "$0")"
[ -d be/node_modules ] || (cd be && bun install)
[ -d fe/node_modules ] || (cd fe && bun install)
(cd be && bun run dev) &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT INT TERM
cd fe && bun run dev
