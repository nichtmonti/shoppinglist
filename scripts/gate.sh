#!/usr/bin/env bash
# The commit gate: `task` (Taskfile.yml says what runs) plus the two things
# go-task leaves out ([D-177]).
#
#   scripts/gate.sh                         the commit gate, no browser ([D-177]),
#                                           on what is not yet on origin/main ([D-299])
#   scripts/gate.sh SINCE=<ref>             on what changed since another base
#   scripts/gate.sh full                    every non-browser layer at full scope
#   scripts/gate.sh e2e:functional -- tests/conflicts.spec.ts
#   scripts/gate.sh e2e                     every harness (CI's matrix)
#
# 1. go-task names only the first failed task. Every layer records its own
#    failure (the `defer` in each), and this prints them all.
# 2. go-task ignores a TERM sent to it and leaves its commands running: it
#    expects Ctrl-C to reach the whole process group. This runs it in a group
#    of its own and stops that group.
#
# The output also goes to logs/gate-<stamp>.log (logs/latest.log).
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "${SHOPPINGLIST_DEVCONTAINER:-}" != 1 ]; then
	echo "error: run the gate inside the devcontainer (scripts/agent.sh starts an agent there)" >&2
	exit 2
fi

# SINCE=<ref> as an argument becomes the environment the Taskfile reads:
# go-task evaluates its shared variables before it applies one given as an
# argument, so `task gate SINCE=main` alone scoped nothing ([D-299]).
args=()
for arg in "$@"; do
	case $arg in
	SINCE=*) export SINCE="${arg#SINCE=}" ;;
	*) args+=("$arg") ;;
	esac
done
set -- "${args[@]}"

mkdir -p logs
log=logs/gate-$(date +%Y%m%d-%H%M%S)-$$.log
ln -sfn "${log#logs/}" logs/latest.log
export GATE_FAILED
GATE_FAILED=$(mktemp)
status_file=$(mktemp)
trap 'rm -f "$GATE_FAILED" "$status_file"' EXIT

set -m
{
	task "$@"
	echo $? >"$status_file"
} 2>&1 | tee "$log" &
pgid=$(ps -o pgid= "$!" | tr -d ' ')
trap 'kill -TERM -- "-$pgid" 2>/dev/null; exit 143' TERM HUP
trap 'kill -TERM -- "-$pgid" 2>/dev/null; exit 130' INT
wait "$!"
status=$(cat "$status_file" 2>/dev/null || echo 1)

if [ -s "$GATE_FAILED" ]; then
	echo
	echo "gate FAILED: $(sort -u "$GATE_FAILED" | tr '\n' ' ')(log: $log)"
fi
exit "${status:-1}"
