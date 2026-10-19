#!/bin/sh
# Builds the SvelteKit SPA and puts it in backend/pb_public, where the backend
# embeds it at compile time ([D-64]): run this before any `go build` without
# `-tags no_ui`. Expects frontend/'s dependencies to be installed.
#
# With SHOPPINGLIST_DEMO_BUILD=1 it builds the demo's SPA instead ([D-234]):
# frontend/build-demo into backend/pb_public_demo, which only the demo binary
# embeds (scripts/build-demo.sh). Either way it checks which one it built by
# the demo's start route: a normal SPA that mentions it has demo code in it.
#
# POSIX sh: it also runs in the CI image, whatever its shell.
set -eu
cd "$(dirname "$0")/.." # repo root

MARKER=/api/demo/start
if [ "${SHOPPINGLIST_DEMO_BUILD:-}" = 1 ]; then
	OUT=frontend/build-demo
	DEST=backend/pb_public_demo
else
	OUT=frontend/build
	DEST=backend/pb_public
fi

(cd frontend && pnpm build)
if grep -rqF "$MARKER" "$OUT"; then
	if [ "$OUT" = frontend/build ]; then
		echo "build-embedded-spa.sh: the normal SPA contains demo code ($MARKER) — #demo must resolve to src/lib/demo/off.ts" >&2
		exit 1
	fi
elif [ "$OUT" = frontend/build-demo ]; then
	echo "build-embedded-spa.sh: the demo SPA has no demo code ($MARKER) — #demo must resolve to src/lib/demo/on.ts" >&2
	exit 1
fi
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$OUT"/. "$DEST"/
