# frontend

The shoppinglist SPA: SvelteKit 3 + Svelte 5 (runes) + `adapter-static`, built to a single
`index.html` shell and served by PocketBase out of `pb_public`. Routing is
client-side and every read comes from IndexedDB (Dexie). The app is
offline-first, so there is no SSR and no server-side data loading.

[`docs/internals/design.md`](../docs/internals/design.md) is the binding spec.

## Commands

The toolchain lives only in [`../.devcontainer/Dockerfile`](../.devcontainer/Dockerfile);
there is no `pnpm` on the host. From inside the dev container:

```sh
pnpm dev               # Vite dev server; needs PocketBase too — use ../scripts/dev.sh
pnpm lint              # type-aware eslint (prettier lives at the repo root: pnpm format / format:check)
pnpm check             # svelte-check + the service-worker tsconfig
pnpm test              # unit + component (the `server` and `client` vitest projects)
pnpm test:integration  # two clients against the REAL built backend binary
pnpm build             # -> build/ (`task build-spa` copies it into ../backend/pb_public)
```

`../scripts/dev.sh` runs PocketBase and Vite together on one origin (Vite proxies
`/api` to :8090). A passkey is bound to the exact origin it was created on, so
open **http://localhost:5173**, never `127.0.0.1`.

## Layout

- `src/lib/sync/`: the §8 sync engine (outbox, push, digest, snapshot, SSE,
  leader election). The densest and most heavily tested part of the app.
- `src/lib/actions/`: every mutation entry point. Components call these; they
  never touch `pb` or `db` directly.
- `src/lib/components/`: one directory per surface, most with their
  `*.svelte.test.ts` alongside.
- `src/integration/`: suites against the real Go binary, a separate vitest
  project that never runs in the unit sweep: `behaviour/` states sync
  *outcomes* and must survive a different sync engine, `engine/` drives the
  current engine's modules directly
  ([impl-notes](../docs/internals/impl-notes.md#sync-behaviour-suite)).
- `messages/` + `project.inlang/`: Paraglide catalogues (§12.2: de + en).

Scaffolded originally with:

```sh
pnpm dlx sv@0.16.4 create --template minimal --types ts \
  --add prettier eslint vitest="usages:unit" --no-download-check --install pnpm frontend
```
