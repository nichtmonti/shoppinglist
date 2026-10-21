#!/usr/bin/env bash
# The dev environment: PocketBase under air (backend/.air.toml; a .go save
# rebuilds and restarts it) and the Vite dev server (HMR), on one origin
# through Vite's /api proxy (frontend/vite.config.ts). That one origin is what
# makes passkeys work here: open http://localhost:5173, not 127.0.0.1.
#
# --oidc also starts Dex (tools/dex/dev.yaml, which has its users, [D-154])
# and turns the OIDC login on against it; --oidc-only also turns passkeys off
# ([D-76]).
#
# concurrently runs the servers and stops them all on Ctrl-C, a TERM, or when
# one exits; setpriv's parent-death signal stops them when it is SIGKILLed
# ([D-71]). Run it inside the devcontainer.
set -euo pipefail
cd "$(dirname "$0")/.." # repo root

OIDC=""
for arg in "$@"; do
	case "$arg" in
	--oidc) OIDC=on ;;
	--oidc-only) OIDC=only ;;
	-h | --help)
		echo "usage: scripts/dev.sh [--oidc | --oidc-only]"
		exit 0
		;;
	*)
		echo "error: unknown argument: $arg (try --help)" >&2
		exit 1
		;;
	esac
done

if [ "${SHOPPINGLIST_DEVCONTAINER:-}" != 1 ]; then
	echo "error: run dev.sh inside the devcontainer (see CONTRIBUTING.md)" >&2
	exit 1
fi
# air comes from tools/air ([D-75]), which is its pin: no version here.
if ! command -v air >/dev/null 2>&1; then
	echo "error: air not found — rerun .devcontainer/postCreate.sh, or just:" >&2
	echo "       go -C tools/air install tool" >&2
	exit 1
fi

PORT="${PORT:-8090}"
VITE_PORT="${VITE_PORT:-5173}"
export SHOPPINGLIST_RP_ID="${SHOPPINGLIST_RP_ID:-localhost}"
export SHOPPINGLIST_RP_ORIGIN="${SHOPPINGLIST_RP_ORIGIN:-http://localhost:${VITE_PORT}}"

# Each server is execed (no shell left between it and concurrently) under
# `setpriv --pdeathsig TERM`. air stops its own server on that TERM.
run="exec setpriv --pdeathsig TERM"
cmds=(
	# Why the args are here, --dir included: backend/.air.toml.
	"cd backend && $run air --build.args_bin 'serve,--http=127.0.0.1:${PORT},--dir=pb_data'"
	# --strictPort: Vite would otherwise move to the next port when this one
	# is busy, and the URL below would point at whatever holds it.
	"cd frontend && $run node node_modules/vite/bin/vite.js dev --strictPort --port ${VITE_PORT}"
)
ports=("$PORT" "$VITE_PORT")

# The address and client are tools/dex/dev.yaml's, whose redirectURIs allow
# :5173 (and :8090) only.
DEX_PORT=5556
if [ -n "$OIDC" ]; then
	if [ "$VITE_PORT" != 5173 ]; then
		echo "warning: tools/dex/dev.yaml allows the redirect on :5173 only;" >&2
		echo "         with VITE_PORT=$VITE_PORT Dex will refuse the sign-in." >&2
	fi
	export SHOPPINGLIST_OIDC=on
	export SHOPPINGLIST_OIDC_CLIENT_ID=shoppinglist
	export SHOPPINGLIST_OIDC_CLIENT_SECRET=shoppinglist-secret
	export SHOPPINGLIST_OIDC_ISSUER="http://127.0.0.1:${DEX_PORT}/dex"
	export SHOPPINGLIST_OIDC_NAME=Dex
	[ "$OIDC" = only ] && export SHOPPINGLIST_PASSKEYS=off
	# `go tool` forwards the TERM to Dex. The first run compiles it (minutes).
	cmds+=("$run go -C tools/dex tool dex serve dev.yaml")
	ports+=("$DEX_PORT")
fi

# A port held now is not a leftover of ours (the kernel stops those), and the
# browser would talk to it instead of this tree: refuse. Whatever answers
# once the servers start is therefore theirs, which is when the URL prints.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for port in "${ports[@]}"; do
	if port_open "$port"; then
		echo "error: :$port is already in use; stop whatever holds it first." >&2
		exit 1
	fi
done
({
	for port in "${ports[@]}"; do
		until port_open "$port"; do
			kill -0 $$ 2>/dev/null || exit 0 # concurrently is gone
			sleep 0.2
		done
	done
	echo "open http://localhost:${VITE_PORT}"
	[ -z "$OIDC" ] || echo "OIDC login on: press \"Weiter mit Dex\" (browser on the host? forward port $DEX_PORT too)"
} &)

# --raw: the servers write to the terminal, not through concurrently, so a
# SIGKILLed concurrently leaves air its output to finish stopping the server.
exec node_modules/.bin/concurrently --raw --kill-others "${cmds[@]}"
