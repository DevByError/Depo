#!/usr/bin/env sh
# Start the API on macOS or Linux. Run its tests with: ./run.sh test
set -eu
cd "$(dirname "$0")"

PY=python3
command -v python3 >/dev/null 2>&1 || PY=python
if [ ! -x .venv/bin/python ]; then
  echo "Creating a virtual environment in .venv ..."
  "$PY" -m venv .venv
fi
VPY=.venv/bin/python
[ -f .env ] || cp .env.example .env

if [ "${1:-}" = "test" ]; then
  "$VPY" -m pip install -q -r requirements-dev.txt
  exec "$VPY" -m pytest -q
fi

"$VPY" -m pip install -q -r requirements.txt
"$VPY" -m app.seed
PORT="${PORT:-8000}"
echo "The API runs on http://127.0.0.1:$PORT (docs: http://127.0.0.1:$PORT/docs)"
exec "$VPY" -m uvicorn app.main:app --reload --host 127.0.0.1 --port "$PORT"
