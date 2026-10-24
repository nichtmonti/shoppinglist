# Implementation notes

The test layers, the sync behaviour suite and the supported browser baseline.

## Test layers

`scripts/gate.sh` runs these go-task tasks (`Taskfile.yml`, [D-177]) in the
devcontainer: the non-browser layers whose sources changed since they last
passed, two at a time; a browser harness only when named (`e2e:<name>`);
`full` and `e2e` for everything, one gate at a time on the machine. How to run
them, and what to watch for, is in [`AGENTS.md`](../../AGENTS.md#the-gate).

| Task | What it runs | Port |
|---|---|---|
| `deps` | `pnpm install --frozen-lockfile` in `.`, `frontend` and `e2e` when `node_modules` is missing or a lockfile changed | none |
| `format` | prettier, repo-wide, with its cache; every run | none |
| `gofmt` | `gofmt -l` over `backend/`; every run | none |
| `repo-rules` | `scripts/decisions-index.mjs --check` (the index, every `D-nn` cited and the citation links), `scripts/doc-links.mjs` (the links, paths, tasks, scripts and sections the docs name) and `scripts/ci-image-tag.sh --check`; every run, CI's repo-rules step | none |
| `gitleaks` | CI's history scan, then the uncommitted changes and new files; every run ([D-274]) | none |
| `osv` | osv-scanner over every lockfile, CI's osv-scan step, when a lockfile or `osv-scanner.toml` changed | none |
| `lint` | the type-aware ESLint config on the changed files (`lint:all` the whole project) | none |
| `check` | `pnpm check` (svelte-check) and knip | none |
| `check:e2e` | `tsc` and the typed ESLint (eslint-plugin-playwright) over `e2e/`, which Playwright runs with its types stripped | none |
| `go-lint` | go vet, `go fix -diff`, staticcheck, gosec, golangci-lint and deadcode over `backend/`, CI's go-check step, when the backend or their `tools/` pins changed ([D-273]) | none |
| `go-test` | `go test -tags no_ui ./...`, the whole Go suite | none |
| `vitest` | `vitest run --changed` (server + client projects); the whole suite when a config or `frontend/messages/` changes | none |
| `build-backend`, `build-app` | `backend/shoppinglist-no-ui` for the integration project, `backend/shoppinglist` (real SPA) for the server-backed harnesses | none |
| `integration` | the vitest `integration` project: two Dexie clients against the real binary | 8099 |
| `e2e:functional` | the functional browser suite, `e2e/tests/` | 8097 (+8089 invite-only) |
| `e2e:arch` | the dead-controls gate, `e2e/arch/` ([D-124]) | 8096 |
| `e2e:oidc` | the OIDC journeys against Dex, `e2e/oidc/` ([D-154]) | 8095 (+8094 OIDC-only, Dex 5557) |
| `e2e:tiles` | the tile audit and the state audit on the Vite dev server, in Chromium and Firefox, `e2e/tiles/` ([D-166], [D-228], [D-301]) | 8093 |
| `e2e:demo` | the demo binary (`task build-demo`) and its harness, `e2e/demo/` ([D-234]) | 8088 |
| `e2e:upgrade` | the previous release (`task prev-release`, a worktree in `~/.cache/shoppinglist-prev`, outside the checkout because osv and prettier would read its lockfiles as this one's) updated to this build, `e2e/upgrade/`, then its own `integration` project against this server ([D-343]) | 8085, 8084 |

Passkey ceremonies have a Go-side layer too: `testutil.Authenticator` is a
software passkey (one ES256 key, a "none" attestation, real signatures) that
answers the begin routes' options, so `internal/webauthn/ceremony_test.go`
drives register and login through the finish handlers and go-webauthn's
checks, including the refusals a browser cannot be made to send (another
origin, another RP-ID, another key, an earlier challenge). `internal/sectest`
uses it for the takeover regression. Coverage (CI prints the total and lists
the changed lines no test reaches, [D-203]) is a prompt to look, not a target: a test added for a gap should fail when
the property it names is broken, and the ones above were each checked by
breaking the code.

CI is six Woodpecker workflows ([D-66]), every check in one image, the
devcontainer's `toolchain` stage ([D-203]), calling the gate's tasks:
`ci-image.yaml` builds that image on the agent when the agent lacks it
([D-203]); `frontend.yaml` runs `task repo-rules`, then `task format check
check:e2e lint:all`, then the server + client vitest projects with coverage;
`go.yaml` runs `task gofmt go-lint` and `task gitleaks`, then the Go suite;
`e2e.yaml` builds the binary and holds the boot path to its budget
(`scripts/bundle-budget.mjs`), checks `docs/THIRD_PARTY_LICENSES.md`, runs the
integration project and every browser harness, then `task coverage:go` over
the Go suite and what the servers reached; `security.yaml` runs govulncheck
and `task osv` on a weekly cron and a dependency change; `release.yaml`
publishes a tag after that tag's own `e2e` run passed.

## Sync behaviour suite

The outcomes that must survive an engine swap ([D-174]). `frontend/src/integration/` holds two
layers against the real binary, split by what they are allowed to know:

- **`engine/`**: the engine suite and the audit repros. They drive `outbox`, `push`,
  `digest` and `snapshot` directly and assert on engine state. The unit tests in `src/lib/sync/`
  are the same kind, one level down. A new engine replaces these.
- **`behaviour/`**: outcomes only. Simulated **devices** act through the app's own actions (the
  add box's `planAdd`, `#lib/actions/*`) and are judged by what each person sees and was told,
  compared with the server's rows through one shared projection. `world.ts` is the *only* file
  there that knows how sync works (its `sync()` and the storage `view()` reads); lint
  (`frontend/eslint.shared.config.js`) refuses a spec there that imports `#lib/sync`, `#lib/db`,
  `#lib/pb`, `#lib/actions`, the harness or the test kit, statically, dynamically or by a relative
  path, or that calls `vi.mock` ([D-306]). A new engine rewrites `world.ts`, and every spec must
  pass unchanged.

Specs: `propagation` (a change reaches everyone), `conflicts` ([§8.1]–[§8.4]: disjoint fields merge,
first-committed-wins with a notice to the loser, identical intent silent, edit-vs-remove, duplicate
adds, refused edits), `lifecycle` (joining with history, leaving with a queue on another device,
last member out, the shared list name, clearing purchase times), `faults` (lost answers, server
errors, failing reads, a whole trip offline, an expired session) and `fuzz` (below).

**The network is per device.** Every request carries its bearer token, and the world's fetch
wrapper keys on it to take one device offline, inject a fault (`unreachable`, `server-error`,
`lost-response`, where the server acts and the answer never arrives) or give it its own client address via
`X-Forwarded-For`, which the integration server trusts (`SHOPPINGLIST_TRUSTED_PROXY_HEADER`):
every PocketBase and [§10] limit is per IP, and a stress run from one address measured the rate
limiter ([D-77]: adapt the harness, never the limit). Two traps it met: PocketBase tokens are
**deterministic JWTs**, so two devices of one account opened in the same second got the same token
and the per-token network merged them (each device impersonates with its own lifetime); and
the engine emits a `denied/not_member` for a departed member's queue that the app deliberately
does not show (`state/sync-notices.ts`, [D-138]), so the world reports what the app *shows*.

**`fuzz.test.ts`** runs seeded random walks (four devices, a small name pool so adds collide,
some respelt in another case or spacing; ticks taken back as well as unticked to buy again;
renames, moves to another aisle, aisle renames, hides
and restores, a purchase-history reset; random offline windows, syncs of several devices at once,
actions taken while the device is mid-sync, expired sessions, faults injected into pushes, digests,
snapshots and the history reset, realtime events heard late or never (`world.broadcast`/`hear`), and
the server's clean-up deleting removed never-bought rows and hidden aisles for good),
then settles everyone and checks five engine-free invariants by normalized name: convergence
(every device equals the server, nothing unsynced), no lost adds (bar a name the clean-up took and
nobody added again), no phantoms, one living row per
name, and no invented quantity or note. A rename only picks a name nobody has, since a rename
into a name on the list is not merged ([§8.3]), and a rename may itself be lost to an earlier one or
to a removal. Defaults: 8 seeds ×
60 steps (~30 s). `STRESS_SEEDS=100,101 STRESS_STEPS=200` for longer runs; `STRESS_TRACE=<name>`
logs the server's and every device's rows for that name after each step. 60 seeds × 200 steps
found two gaps (seeds 112 and 136): a check-off dropped by a convergent delete ([D-175]) and a
restore lifting a tombstone beside a re-added twin ([D-176]). Both are fixed and are ordinary
scenarios in `conflicts.test.ts`; the gaps were pinned with `test.fails` while open, which turns
red the moment a fix lands. That is the pattern to reuse for the next one. After the fixes, 360 seeds × 200 steps
pass. **Run at most 50 seeds per invocation at 300 steps, ~100 at 200:** every seed opens four
devices, each a fresh module graph with its own fake IndexedDB, and one vitest worker accumulating
them ran out of heap around seed 140 at 200 steps (the run then reports fewer tests than seeds, with an unhandled "Worker exited unexpectedly",
not a sync failure). Batch longer runs. `[sync] reconcile failed to converge` lines during a run with
injected `lost-response` faults were the engine's own tripwire reporting a create that landed while
its answer was lost (snapshot.ts `verifyConverged`); the next cycle settled it. Since the digest is
computed over the shadow ([D-40]) such a create is in it, and the line is rare (1 in 40 seeds × 120
steps, down from 67).

**Mutation-checked.** *(The fix it pinned, settling from the push response, was later replaced within [D-40] by the shadow store; the scenario still runs and passes.)* Removing that fix fails the refused-edit scenario, but only after it
was rewritten so Ben's device receives Anna's newer note while his edit is still queued (a push
fault, then the retry is refused); the first version, with Ben offline throughout, never reached
the code path and passed against the bug. Disabling the server's duplicate-name merge ([D-29])
fails three conflict scenarios and 7 of 8 default fuzz seeds.

## Supported browser baseline

**The baseline is Safari/iOS 16.4, Chrome 111, Firefox 128**, Tailwind 4's own
documented floor ([compatibility](https://tailwindcss.com/docs/compatibility)),
adopted because the CSS build cannot target anything older anyway.

What that floor does **not** give you is a blanket guarantee for every newer
browser feature the app might reach for. Tailwind's floor is about the CSS
*Tailwind emits*; anything written by hand in `app.css`, or any JS API called
from a component, has its own support history and has to be checked against the
baseline separately, including individual sub-features of an API that is itself
old enough. Concrete cases already in the tree, each checked against the floor:

| Feature | Where | Note |
|---|---|---|
| `:has()` | `shop-tile.css` (tile states, compact density) | Safari 15.4, Chrome 105 |
| `color-mix()` | category chips | Safari 16.2, Chrome 111 |
| `text-wrap: balance` | tile names | Safari 17.5, **above the floor**; degrades to normal wrapping, which is why it is used only where the fallback is acceptable |
| `content-visibility` / `contain-intrinsic-size` | long lists | Safari 18, Chrome 85. Same reasoning: a progressive enhancement, never a correctness dependency |
| `dvh` | app shell, drawer cap | Safari 15.4, Chrome 108 |
| Web Locks | `sync/leader.ts` | Safari 15.4, Chrome 69, and `requestLeadership` has an explicit no-Locks fallback path |
| `BroadcastChannel` | `#lib/auth/session` ([D-109]) | Safari 15.4, Chrome 54; guarded, and the local half of the session boundary works without it |
| `AbortSignal.any` | `sync/http.ts` `anySignal` ([D-341]) | Safari 17.4 and Chrome 116, **above the floor** (Firefox 124 is within it); `anySignal` builds the same from a controller and listeners where it is missing, and lint refuses a direct call |
| Module service worker | `src/service-worker/`, registered by SvelteKit 3 with `type: 'module'` ([D-242]) | Safari/iOS 15, Chrome 91, **Firefox 147, above the floor**; an older Firefox runs the app online but registers no worker, so it has no offline cold start and cannot install it |

The rule to follow when adding one: **check the specific feature, not the
family**, and if it sits above the floor make sure the app is still correct
without it. `text-wrap: balance` and `content-visibility` are the model:
both are pure polish and nothing depends on them having applied.

The baseline is a support target, not a tested matrix: every browser suite runs
Chromium, and the tiles harness Firefox too ([D-301]), so **Safari/iOS
behaviour is unverified**.

<!-- citation links (generated by scripts/decisions-index.mjs) -->

[§8.1]: design.md#8-1-conflict-policy-d-11
[§8.3]: design.md#8-3-push-endpoint-server-side-merge
[§8.4]: design.md#8-4-conflict-ux-client-d-11
[§10]: design.md#10-security-summary
[D-29]: decisions.md#D-29
[D-40]: decisions.md#D-40
[D-66]: decisions.md#D-66
[D-77]: decisions.md#D-77
[D-109]: decisions.md#D-109
[D-124]: decisions.md#D-124
[D-138]: decisions.md#D-138
[D-154]: decisions.md#D-154
[D-166]: decisions.md#D-166
[D-174]: decisions.md#D-174
[D-175]: decisions.md#D-175
[D-176]: decisions.md#D-176
[D-177]: decisions.md#D-177
[D-203]: decisions.md#D-203
[D-228]: decisions.md#D-228
[D-234]: decisions.md#D-234
[D-242]: decisions.md#D-242
[D-273]: decisions.md#D-273
[D-274]: decisions.md#D-274
[D-301]: decisions.md#D-301
[D-306]: decisions.md#D-306
[D-341]: decisions.md#D-341
[D-343]: decisions.md#D-343
