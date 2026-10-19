# The running devcontainer, for scripts on the host ([D-252]): sourced by
# scripts/agent.sh and the pre-push hook (.githooks/pre-push, [D-274]).
#
#   find_container   prints its name, or nothing when none runs

find_container() {
	docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null |
		awk -F'\t' '$2 ~ /^vsc-shoppinglist/ {print $1; exit}'
}
