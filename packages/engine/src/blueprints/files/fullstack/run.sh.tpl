#!/usr/bin/env sh
# Start the API and the web app on macOS or Linux; Ctrl+C stops both. Run every test with: ./test.sh
set -eu
cd "$(dirname "$0")"

sh api/run.sh &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT INT TERM
sh web/run.sh
