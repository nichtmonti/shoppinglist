#!/usr/bin/env bash
# The machine lock, shared by the Taskfile's gate and harnesses and by
# scripts/shots.sh.
#
# One of them runs at a time on this machine, in whichever checkout or
# worktree ([D-177]). They share the container, every harness port and the
# box's 8 GB, and two browser phases at once do not fit: before this lock,
# gates in two checkouts ran side by side on shifted ports and both timed out.
# The lock lives in the git common dir, the one place every checkout of this
# repository shares.
#
#   machine_lock <who>   (sourced) hold the lock on fd 9 until the shell
#                        exits, waiting for it if another run holds it.
#   lock.sh <who> <command…>   run the command holding it.
#
# A run inside one that holds it (the harnesses `task e2e` runs) does not
# wait for itself: GATE_LOCK_HELD marks the holder's children.
machine_lock() {
	[ -n "${GATE_LOCK_HELD:-}" ] && return 0
	local lock dir
	# Sourced, the caller's shell may not stop on an error: every step that
	# can leave the run without the lock returns its failure.
	dir=$(git rev-parse --path-format=absolute --git-common-dir) || return 1
	lock="$dir/gate.lock"
	exec 9>"$lock" || return 1
	if ! flock -n 9; then
		echo "$1: waiting for the run that holds the machine: $(cat "$lock.who" 2>/dev/null || echo unknown)"
		flock 9 || return 1
	fi
	echo "$1 in $(pwd -P), pid $$, since $(date +%H:%M:%S)" >"$lock.who"
	export GATE_LOCK_HELD=1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	set -euo pipefail
	machine_lock "$1"
	shift
	exec "$@"
fi
