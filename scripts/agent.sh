#!/usr/bin/env bash
# Start a coding agent INSIDE the devcontainer, in the directory you call this
# from (the main checkout or a worktree under .claude/worktrees/):
#
#   scripts/agent.sh                  # claude
#   scripts/agent.sh opencode         # or omp, or any command on the container's PATH
#   scripts/agent.sh claude --resume  # arguments go to the agent
#
# Inside, the agent's commands are ordinary child processes: go, node, pnpm and
# Playwright run directly, Ctrl-C reaches them, and the repo is at the same path
# as on the host. Its binary, login and sessions are the host account's,
# bind-mounted by devcontainer.json, so a session started here resumes on the
# host and the other way round.
#
# With no container running it starts one (the official devcontainer CLI,
# through npx). A container from before the agent mounts is not replaced
# unasked, because a rebuild stops everything running in it: the script says
# how, and stops.
set -euo pipefail

# Renovate updates the version (a custom manager in renovate.json5).
DEVCONTAINER_CLI=@devcontainers/cli@0.90.0

# The main checkout: the devcontainer is created from it, never from a worktree
# (a second container on a nested copy shares the build directories, AGENTS.md).
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)

# shellcheck source=lib/container.sh
. "$(dirname "$0")/lib/container.sh"

C=$(find_container)
if [ -z "$C" ]; then
	echo "agent: no devcontainer running, starting one from $main" >&2
	npx --yes "$DEVCONTAINER_CLI" up --workspace-folder "$main" >&2
	C=$(find_container)
	[ -n "$C" ] || {
		echo "agent: the devcontainer did not come up" >&2
		exit 1
	}
fi

# Built from the current devcontainer.json: the repo at its host path, and the
# agents' directories mounted.
mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' "$C")
if ! grep -qxF "$main" <<<"$mounts" || ! grep -qxF /home/dev/.claude <<<"$mounts"; then
	cat >&2 <<EOF
agent: the running devcontainer ($C) predates the agent mounts in
       .devcontainer/devcontainer.json. Rebuild it, which stops everything
       running in it (other agents' gates, VS Code's server):
         npx --yes $DEVCONTAINER_CLI up --workspace-folder $main --remove-existing-container
       or, in VS Code: "Dev Containers: Rebuild Container".
EOF
	exit 1
fi

# Start where this was called from, if the container sees it.
dir=$(pwd -P)
case "$dir/" in "$main"/*) ;; *) dir=$main ;; esac

tty=(-i)
[ -t 0 ] && [ -t 1 ] && tty=(-it)
exec docker exec "${tty[@]}" -w "$dir" \
	-e TERM="${TERM:-xterm-256color}" -e COLORTERM="${COLORTERM:-}" \
	"$C" bash -lc 'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"; exec "$@"' agent "${1:-claude}" "${@:2}"
