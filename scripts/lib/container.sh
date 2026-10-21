# The running devcontainer, for scripts on the host ([D-252]): sourced by
# scripts/agent.sh and the pre-push hook (.githooks/pre-push, [D-274]).
#
#   find_container   prints its name, or nothing when none runs; fails, with
#                    docker's own message, when docker cannot be asked

find_container() {
	local running
	running=$(docker ps --format '{{.Names}}\t{{.Image}}') || return 1
	printf '%s\n' "$running" | awk -F'\t' '$2 ~ /^vsc-shoppinglist/ {print $1; exit}'
}
