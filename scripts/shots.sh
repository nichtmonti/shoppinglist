#!/usr/bin/env bash
# Screenshots of the app and of the design gallery, taken in the devcontainer
# by the e2e/shots harness. Run it inside the devcontainer.
#
#   scripts/shots.sh app [--label L] [--locales "en de"] [--themes "light dark"]
#       The real app as one household's story — sign-in, home, suggestions,
#       a real barcode scan and the product it finds, the list, an item's
#       detail sheet, sharing, the shopping view, a list pasted in from
#       another app and its review — plus a clip of two phones
#       syncing (clip.webp). Needs internet: the scan's lookup is real.
#       Builds the binary first.
#   scripts/shots.sh gallery [--label L] [--clip] [STATE...]
#       Every preview of each gallery STATE, a /dev/gallery query string such as
#       'view=shop&density=compact,rows' or 'compare=<id>'. Default: both views,
#       both themes. The before/after evidence for an item-component or CSS
#       change: run it with --label before, change, run it with --label after.
#   scripts/shots.sh readme [IMAGE...]
#       Regenerates the README's images in docs/screenshots/ (English, and
#       one German shot), or only the IMAGEs named: plan add item lists
#       import clip. Each but the clip is two screens side by side
#       (e2e/shots/pair.ts). A named run shoots only the locales, themes and
#       screens those need, and skips the clip and the barcode scan (the one
#       step that needs internet) unless an image shows them: `readme
#       import` takes about half as long.
#   scripts/shots.sh docs
#       Regenerates the deployment reference's images in docs/images/:
#       sign-up by invite, the share sheet, and the OIDC login against Dex.
#       Builds the binary first.
#
# Images go to logs/shots/<stamp>[-label]/ (logs/shots/latest points at the
# newest) and the paths are printed at the end. A run holds the machine lock,
# as a gate does (scripts/lib/lock.sh, [D-177]): it waits for a running gate
# or shots run in any checkout. It runs beside scripts/dev.sh.
set -uo pipefail
cd "$(dirname "$0")/.." # repo root

usage() {
	sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

MODE=${1:-}
[ $# -gt 0 ] && shift
LABEL= LOCALES= THEMES= CLIP= STATES=()
case "$MODE" in
app | gallery | readme | docs) ;;
*) usage ;;
esac
while [ $# -gt 0 ]; do
	case "$1" in
	--label) LABEL=$2 && shift 2 ;;
	--locales) LOCALES=$2 && shift 2 ;;
	--themes) THEMES=$2 && shift 2 ;;
	--clip) CLIP=1 && shift ;;
	-h | --help) usage ;;
	-*) echo "shots: unknown option $1" >&2 && usage ;;
	*) STATES+=("$1") && shift ;;
	esac
done
[ "$MODE" = gallery ] || [ "$MODE" = readme ] || [ ${#STATES[@]} -eq 0 ] || usage

# The README's images, each with the shots it is made of: two screens of
# the app story (<locale>/<theme>/<n>-<screen>), side by side, or the clip
# (<locale>/clip). One screen per core feature, for a reader who does not
# play the clip, English light except the German bought items in dark,
# which shows both at once. Pairs, so they fill a laptop's column and a
# phone's alike ([D-286]).
declare -A README_SHOTS=(
	[plan]="en/light/9-shop en/light/6-list" [add]="en/light/3-suggest en/light/5-found"
	[item]="en/light/7-detail en/light/8-share" [lists]="en/light/2-home de/dark/12-done"
	[import]="en/light/10-import en/light/11-review" [clip]=en/clip
)
if [ "$MODE" = readme ]; then
	IMAGES=("${STATES[@]}")
	[ ${#IMAGES[@]} -eq 0 ] && IMAGES=("${!README_SHOTS[@]}")
	WANT=
	for image in "${IMAGES[@]}"; do
		if [ -z "${README_SHOTS[$image]:-}" ]; then
			echo "shots: no README image '$image'; there are: ${!README_SHOTS[*]}" >&2
			exit 2
		fi
		WANT+="${README_SHOTS[$image]} "
	done
	STATES=()
	MODE=app README=1 LABEL=readme
elif [ "$MODE" = docs ]; then
	MODE=app DOCS=1 LABEL=docs
fi

if [ "${SHOPPINGLIST_DEVCONTAINER:-}" != 1 ]; then
	echo "shots: run it inside the devcontainer (scripts/agent.sh starts an agent there)" >&2
	exit 2
fi

# Job control gives the build and the shoot a process group each, so a stopped
# run takes Playwright and its servers down by group id.
set -m
PGID=
on_signal() { # on_signal <exit-status>
	trap - INT TERM HUP
	[ -n "$PGID" ] && kill -TERM -- "-$PGID" 2>/dev/null
	exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

mkdir -p logs/shots
# shellcheck source=lib/lock.sh
. scripts/lib/lock.sh
machine_lock shots

OUT_REL="logs/shots/$(date +%Y%m%d-%H%M%S)${LABEL:+-$LABEL}"
mkdir -p "$OUT_REL"
ln -sfn "${OUT_REL#logs/shots/}" logs/shots/latest
ROOT=$(pwd -P)
ENV=(SHOTS_OUT="$ROOT/$OUT_REL")

if [ "$MODE" = app ]; then
	# The gate's build-app task: skipped when its sources are unchanged.
	echo "── building the app (log: $OUT_REL/build.log)"
	task build-app >"$OUT_REL/build.log" 2>&1 &
	PGID=$!
	if ! wait "$PGID"; then
		tail -n 30 "$OUT_REL/build.log"
		echo "shots: the build failed" >&2
		exit 1
	fi
	ENV+=(SHOPPINGLIST_BIN="$ROOT/backend/shoppinglist")
	[ -n "$LOCALES" ] && ENV+=(SHOTS_LOCALES="$LOCALES")
	[ -n "$THEMES" ] && ENV+=(SHOTS_THEMES="$THEMES")
	[ -n "${WANT:-}" ] && ENV+=(SHOTS_WANT="$WANT")
	CONFIG=shots/app.config.ts
	[ -n "${DOCS:-}" ] && CONFIG=shots/docs.config.ts
else
	[ ${#STATES[@]} -gt 0 ] && ENV+=(SHOTS_GALLERY="${STATES[*]}")
	[ -n "$CLIP" ] && ENV+=(SHOTS_CLIP=1)
	CONFIG=shots/gallery.config.ts
fi

echo "── shooting ($MODE; log: $OUT_REL/run.log)"
(cd e2e && env "${ENV[@]}" npx playwright test -c "$CONFIG") >"$OUT_REL/run.log" 2>&1 &
PGID=$!
wait "$PGID"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
	tail -n 40 "$OUT_REL/run.log"
	echo "shots: FAILED (exit $STATUS) — full log in $OUT_REL/run.log" >&2
	exit "$STATUS"
fi

if [ -n "${README:-}" ]; then
	# A full run replaces the directory, so an image the README dropped goes
	# with it; a named run replaces only what it shot.
	[ ${#IMAGES[@]} -eq ${#README_SHOTS[@]} ] && rm -rf docs/screenshots
	mkdir -p docs/screenshots
	for image in "${IMAGES[@]}"; do
		read -r left right <<<"${README_SHOTS[$image]}"
		if [ -z "$right" ]; then
			cp "$OUT_REL/$left.webp" "docs/screenshots/$image.webp"
		elif ! (cd e2e && node shots/pair.ts "$ROOT/$OUT_REL/$left.png" "$ROOT/$OUT_REL/$right.png" \
			"$ROOT/docs/screenshots/$image.png"); then
			echo "shots: pairing $image failed" >&2
			exit 1
		fi
	done
	echo "── README images updated in docs/screenshots/: ${IMAGES[*]}"
elif [ -n "${DOCS:-}" ]; then
	rm -rf docs/images && mkdir -p docs/images
	cp "$OUT_REL"/docs/*.png docs/images/
	echo "── deployment reference images updated in docs/images/"
	ls -l docs/images
else
	find "$OUT_REL" -name '*.png' -o -name '*.webp' | sort
fi
