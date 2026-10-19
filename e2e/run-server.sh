#!/usr/bin/env bash
# Serves the app for a Playwright harness. The port and the WebAuthn RP env
# (RP_ID / RP_ORIGIN) come from the harness config (e2e/server.ts); the data
# dir follows the port, so a run on another port starts clean rather than
# inheriting the default run's accounts.
#
# The binary: $SHOPPINGLIST_BIN, which every task and harness config sets,
# else backend/shoppinglist. Nothing is built here: by hand, run `task
# build-app` first (the binary with the SPA embedded, [D-64]), or run the
# harness through `scripts/gate.sh e2e:<name>`, which builds it.
set -euo pipefail
PORT="${E2E_PORT:-8097}"
cd "$(dirname "$0")/.." # repo root

BINARY="${SHOPPINGLIST_BIN:-backend/shoppinglist}"
if [ ! -x "$BINARY" ]; then
	echo "run-server.sh: no $BINARY; run \`task build-app\` first" >&2
	exit 1
fi

DATA_DIR="/tmp/e2e_pbdata_${PORT}"
# A harness whose identities are fixed (e2e/oidc's Dex users) needs an empty
# database: a subject that signed in on the previous run would land on that
# run's account. The passkey suites mint a fresh account per test and keep
# reusing the directory.
if [ -n "${E2E_FRESH_DATA:-}" ]; then
	rm -rf "$DATA_DIR"
fi

# The functional suite seeds a product photo through the superuser API
# (seedProductPhoto in e2e/tests/helpers.ts); e2e/server.ts names the account.
if [ -n "${E2E_SUPERUSER:-}" ]; then
	"$BINARY" superuser upsert "$E2E_SUPERUSER_EMAIL" "$E2E_SUPERUSER_PASSWORD" --dir="$DATA_DIR" >/dev/null
fi

# A harness that reads what the server logs (the invite-only instance's setup
# link, [D-241]) names a file for it; the output still reaches Playwright.
if [ -n "${E2E_SERVER_LOG:-}" ]; then
	: >"$E2E_SERVER_LOG"
	exec "$BINARY" serve --http="127.0.0.1:${PORT}" --dir="$DATA_DIR" > >(tee -a "$E2E_SERVER_LOG") 2>&1
fi
exec "$BINARY" serve --http="127.0.0.1:${PORT}" --dir="$DATA_DIR"
