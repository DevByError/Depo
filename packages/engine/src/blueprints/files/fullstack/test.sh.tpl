#!/usr/bin/env sh
# Run every test on macOS or Linux: the API's pytest suite, then the web app's checks and tests.
set -eu
cd "$(dirname "$0")"
sh api/run.sh test
sh web/run.sh test
