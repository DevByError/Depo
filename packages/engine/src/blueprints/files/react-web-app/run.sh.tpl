#!/usr/bin/env sh
# Start the web app on macOS or Linux. Run its checks and tests with: ./run.sh test
set -eu
cd "$(dirname "$0")"

if command -v npm >/dev/null 2>&1; then PM=npm
elif command -v bun >/dev/null 2>&1; then PM=bun
else
  echo "Node.js 20 or newer is needed: https://nodejs.org/" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing packages ..."
  "$PM" install
fi

if [ "${1:-}" = "test" ]; then
  "$PM" run typecheck
  exec "$PM" run test
fi

echo "The web app runs on http://127.0.0.1:5173"
exec "$PM" run dev
