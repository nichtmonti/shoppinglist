# shoppinglist: Technical Design Document

A self-hostable, offline-first, passwordless shopping-list PWA.

**Status:** the spec of the shipped app; a change lands here in the commit that records its decision.
**Guiding philosophy:** simplicity over feature-creep; must run happily on a Raspberry Pi or a €3 VPS; must work flawlessly with no signal in a supermarket.
**Rationale and rejected alternatives live in [`decisions.md`](decisions.md)**. This document describes the system as it is, not how it got here. Individual decisions are cited inline as `[D-xx]`.

---

## 1. Product overview

An installable Progressive Web App for shared shopping lists:

- **Passwordless & anonymous.** No email or password; identity is a passkey and the account collects no personal data.
- **Offline-first.** Local writes are instant and sync when the network returns.
- **Shareable per-list.** A list is shared by link without exposing the sharer's other lists.
- **Real-time.** A check-off appears on a co-member's device while both are online.
- **Aisle-ordered.** Items are grouped by category in a per-list store-walk order.
- **Self-hostable as one binary** serving both the API and the frontend.

---

## 2. Locked technology stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | **PocketBase, compiled as a Go framework** | Imported into our own `main.go` with custom routes, hooks and crons; one binary. Its email/OTP auth is unused [D-25]. |
| Backend client | **`pocketbase` JS SDK, pinned exactly** ([§14]) | IndexedDB-backed async auth store, realtime SSE, auto-CRUD reads. |
| WebAuthn (backend) | **`go-webauthn/webauthn`** (pinned) | Carries **all** cryptography and protocol logic. It validates the Backup-Eligible / Backup-State flags, so the full `Credential` struct is persisted as JSON. |
| WebAuthn (frontend) | **`@simplewebauthn/browser`** | Browser ceremony and ArrayBuffer↔base64url conversion. |
| Frontend | **SvelteKit static SPA** (`adapter-static`) | Built into `backend/pb_public` and embedded in the binary ([D-64]). |
| Local DB | **Dexie** | Apache-2.0 core only; not Dexie Cloud. |
| PWA shell | SvelteKit's service worker | App-shell precache. |
| i18n | **Paraglide**, compile-time, `@inlang/paraglide-js` pinned to the **2.x line** ([§14]) | No runtime fetch, so it works offline. de/en, additive locale files ([§12.2]). |
| Barcode scan | **`barcode-detector` ponyfill** with **`zxing-wasm`** at the version the ponyfill inlines its glue from ([D-21]; `wasm-version.test.ts`) | Decoded on the device by WASM zxing-cpp on every browser; lookup via Open Food Facts ([§9.2]). Operator-disableable. |

### Accepted stack risks

- **PocketBase is pre-1.0 and single-maintainer.** Pinned exactly ([§14]); all state is one SQLite file.
- **PocketBase has no native WebAuthn.** Our passkey layer ([§5]) is small and swappable.
- **PocketBase's token-minting API moves between versions** (`apis.RecordAuthResponse`); check it on every upgrade.

---

## 3. Architecture at a glance

```
┌──────────────────────────────────────────────────────────┐
│  Single self-built binary                                │
│  ┌────────────────┐   ┌──────────────────────────────┐   │
│  │  pb_public/    │   │  PocketBase core             │   │
│  │  (SvelteKit    │   │  - SQLite                    │   │
│  │   static SPA)  │   │  - auto-CRUD READS + rules   │   │
│  └────────────────┘   │  - realtime (SSE)            │   │
│  ┌──────────────────┐ │  - cron (sweeps, GC)         │   │
│  │ custom Go routes │ │  - scheduled backups         │   │
│  │ - passkey, OIDC  │ │  ┌────────────────────────┐  │   │
│  │ - sync push,     │─┼─▶│ go-webauthn (crypto)   │  │   │
│  │   digest, snap.  │ │  └────────────────────────┘  │   │
│  │ - lists, invites,│ │                              │   │
│  │   roster         │ │                              │   │
│  │ - account        │ │                              │   │
│  │ - barcode proxy  │ │                              │   │
│  └──────────────────┘ └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
        ▲ HTTPS (operator's proxy)            ▲ realtime SSE
┌───────┴──────────────────────────────────────┴──────────┐
│  Browser / installed PWA                                 │
│  SvelteKit SPA ── Dexie (IndexedDB) ── outbox sync loop  │
│  (Web-Locks leader election across tabs)                 │
│  passkey in OS keychain (iCloud / Google / manager)      │
└──────────────────────────────────────────────────────────┘
```

**Write path:** every client mutation to shared data goes through `POST /api/sync/push` (server-side per-field merge, [§8]). PB auto-CRUD serves **reads and realtime only** (incl. read-only `category_templates` / `item_dictionary`), except that the sync engine reads through the authenticated `GET /api/sync/digest` and `GET /api/sync/snapshot/{listId}`, so a refusal is never an empty 200 ([D-28], [D-173]). Direct client writes to `items` / `list_categories` are denied by rule, and to `lists` all but a member's rename ([§6.4], [§11]).

---

## 4. Account & identity model

### 4.1 Core principle: credential-agnostic identity

**An account is a stable ID that _has_ one or more credentials; it never _is_ a passkey or a login.** Adding passkeys or an OIDC login ([D-76]) needs no migration.

### 4.2 Anonymous account

- The identity field is a server-generated **random `handle`**, not an email. No PII is collected.
- The **nickname** is prefilled **client-side** with a random friendly name (e.g. `SwiftOtter42`) the user may overwrite. The server never invents one (an empty nickname falls back to the handle) and validates it like any input ([§5.4]). **Co-members see nicknames** (roster, [§7.4]), and the UI says so at creation.
- Password auth is **disabled** on the collection. Tokens are minted only by the passkey routes, PocketBase's OAuth2 exchange where configured ([§5.9]), and the demo build's `/api/demo/start` ([D-234]).
- **An OIDC-born account** ([§5.9]) has the provider's display name as `nickname` and a **null `handle`**; to every rule, route and the sync engine it is an ordinary `accounts` row.

### 4.3 Multiple passkeys per account

One account holds N credentials. This is the **recovery story**: losing the only passkey loses the account, so after onboarding the app nudges the user to register a second device as a backup key.

### 4.4 No email login ([D-25], [D-76])

No email login, recovery or notification; no account row holds an address, and the one stored address is the server-only OIDC identity label ([§5.9]). Recovery is a second passkey ([§4.3]) or, where offered, the OIDC login. The `email` column is a PocketBase system field, empty and unwritable from the client ([§11]).

### 4.5 Account deletion (self-service)

`POST /api/account/delete` **leaves every list, then deletes** [D-32]. In one transaction, in order: the caller's `memberships` **one by one through the normal delete pipeline**, so the [§7.3] last-one-out hook fires per list (solo lists go; shared lists keep the account's items, their emptied `modified_by` shown as "someone", [§7.4]); then its `credentials`; then the `accounts` row. Never a bare PB delete or PB's relation cascade. It needs a sign-in from the last five minutes [D-309]: any other token (a session token, a refreshed one) gets 403, unless the account has no login at all (a demo account, [D-234]), so the client signs in again first. The confirmation lists which shared lists stay and which solo lists go.

---

## 5. Authentication (passkey / WebAuthn)

### 5.1 Division of responsibility: we write zero crypto

- **`go-webauthn` owns** challenges, signature verification, COSE key parsing, sign-count / replay checks (a counter that did not advance is logged, not refused), attestation, origin and RP-ID validation.
- **We own** parking `SessionData` between a ceremony's two requests ([§5.5]) and persisting the resulting `Credential`.

### 5.2 The `webauthn.User` interface

```go
WebAuthnID() []byte                          // account id as bytes; at login, the credential's stored user_handle ([D-153])
WebAuthnName() string                        // the nickname (passkey-manager label; display only)
WebAuthnDisplayName() string                 // nickname
WebAuthnCredentials() []webauthn.Credential  // all passkeys for this account
```

### 5.3 Discoverable credentials are mandatory

There is no username to type: registration **requires discoverable keys** (`residentKey: required`, `userVerification: required`), and login is **discoverable** (`BeginDiscoverableLogin` / `ValidatePasskeyLogin`).

### 5.4 The four endpoints

Each wraps exactly one library call.

| Endpoint | Wraps | Behaviour |
|---|---|---|
| `POST /api/passkey/register/begin` | `BeginRegistration` | **New account:** the signup gate (`SHOPPINGLIST_SIGNUP`, [D-61], [D-241]) must admit it: `open` does, `closed` answers 403, `invite` wants a live list invite token (`invite`) or, while no account exists, the boot's setup token (`setup`), whose hash the session keeps. Generates the account id + handle (**not persisted** until finish), takes the nickname. **Adding a passkey:** requires auth. Everything finish needs goes into the session record ([§5.5]). Returns creation options. |
| `POST /api/passkey/register/finish` | `CreateCredential` | Verify attestation; **persist account + credential in one transaction**. A new account asks the gate again inside that transaction, and one admitted by a list invite is saved **with its membership of that list** in the same transaction [D-241]. A new account gets a minted PB auth token; an added passkey returns `{ok: true}`. |
| `POST /api/passkey/login/begin` | `BeginDiscoverableLogin` | Return request options, store `SessionData`. |
| `POST /api/passkey/login/finish` | `ValidatePasskeyLogin` | Verify assertion, resolve credential → account via the user handle, re-store `credential_json` (sign count) and `last_used_at`, mint and return a PB auth token. |

The client stores the token so `pb.authStore` populates like a normal PocketBase login.

**Passkey management.** **Deleting** a passkey is a direct-PB delete of an own `credentials` row ([§11]). **Renaming** goes only through `POST /api/credentials/{id}/rename`, which checks ownership and writes `friendly_name` alone: `credentials` has **no update rule**, since an own-row rule would let a client reparent a passkey onto another account. **Last-credential guard:** a before-delete hook on `credentials` refuses the delete **unless** the account keeps a way in: another passkey while passkeys are on, or an OIDC login (an `ExternalAuth` row, counted only while OIDC is on, [D-25]). Only the account teardown (the [§4.5] route, and the orphan sweep, the [§5.9] link and the demo reset that reuse it) bypasses it, through a request-scoped context flag ([D-32]).

### 5.5 Session-data storage

A ceremony's `SessionData` must survive between its two requests and be single-use. It is held in server memory ([D-03]), in PocketBase's per-app `app.Store()`, one per `(browser_id, type)`; a re-begin of the same type replaces it:

- It holds the library's `SessionData` **plus, for a new account, the pending `{id, handle, nickname, ticket}`** that finish persists, and for an added passkey its friendly name, and the account an added passkey's ceremony was begun for, empty for a signup or a login.
- `browser_id` is a client-generated random ID sent with both requests: a lookup key only; security comes from the signed challenge.
- Finish takes the session by `browser_id`, `type` and the caller's account (empty when signed out) under one lock, so of two finishes one gets it, and a caller who learned another browser's id cannot use or burn its ceremony.
- ~5-minute TTL, checked on use; a begin drops the expired sessions. A restart drops them all, and the ceremony starts again.

### 5.6 Tokens, storage, revocation

- **Auth token: 90 days, sliding**, refreshed at every app start while online ([D-04]); kept in the SDK's async auth store on IndexedDB. A **401** from the refresh or a sync request marks the session expired (auth record and local mirror kept, for [§5.8]'s re-auth), and the sync engine never mounts under the dead token ([D-28]). Any other refresh failure is transient; the local session stays readable offline.
- **A session has a generation** [D-109]: asynchronous work checks it before each write, inside the write's transaction, so nothing arriving after sign-out writes. Sign-out in one tab ends the session in every tab (`#lib/auth/session`).
- **Revocation** is per-account **token-key rotation**: „Überall abmelden“ (`POST /api/account/rotate-token-key`).
- **Sign-out on this device wipes the account's local data** [D-55]: the auth record, the SW photo cache, and through `wipeLocalAccountData` every list-data table (shadows and outbox included), the roster, `scanned_products`, and the account-bound `meta` keys. Device preferences and the seeded vocabulary survive; the auth screen's nickname draft is reset. With edits queued it warns first.

### 5.7 RP-ID / self-hosting config

- RP-ID from **`SHOPPINGLIST_RP_ID`** (origin `SHOPPINGLIST_RP_ORIGIN`), required only while passkeys are on ([§5.9]). **The server refuses to boot** if it is unset or a raw IP.
- **The app needs a secure context** ([D-335]): the server refuses to boot while its address (`SHOPPINGLIST_RP_ORIGIN`, or `SHOPPINGLIST_APP_URL` with passkeys off) is plain `http://` anywhere but `localhost`, `*.localhost` or a loopback address (`webauthn.SecureOrigin`). The demo build is exempt ([D-234]). A browser that reaches the app outside one anyway gets [§12]'s insecure screen.
- Passkeys break if the domain changes or the instance is reached by raw LAN IP; domain migration is not supported.
- The ceremony inside the installed PWA (especially iOS standalone) is covered only by manual device testing ([§14]).

### 5.8 Offline ↔ session policy

- **Local Dexie data is readable and writable with no valid server token.** The token gates **syncing only**.
- **The gate is having authenticated at least once, ever.** After that the device works offline indefinitely.
- An expired token on reconnect shows a **one-tap re-auth prompt**: never silent (WebAuthn needs user activation), **never blocking local use**; **queued edits are kept** and drain right after.
- **Re-auth keeps the account** ([D-76]): one that lands in another account is refused before its session is stored, an account that sign-in just created is deleted with its own token, and the device then remembers the passkey as its login.

### 5.9 OIDC login (opt-in alternative; [D-76])

Passkeys stay the default and the only self-serve signup; an operator may add an OpenID Connect provider as a second login, or run **OIDC-only** (`SHOPPINGLIST_PASSKEYS=off`). PocketBase's OAuth2 machinery owns the code exchange, user-info fetch and account upsert; we own configuration, one provisioning hook and the link/unlink routes.

- **Configuration** (the variables: [deploy-reference.md](../deploy-reference.md#oidc-login)). `SHOPPINGLIST_OIDC=on|off` is the switch; the endpoints come from the issuer's discovery document ([D-208]), or explicit URLs for a provider without one. `oidc.Apply` writes `accounts.OAuth2` at serve time: `on` ⇒ the `oidc` provider (other provider rows kept); `off`/unset ⇒ OAuth2 off, dashboard-added providers included, and `auth-with-oauth2` refuses. The boot fails on connection variables without the switch, neither login on, or an invalid value ([D-61]), and logs how many accounts a switched-off login strands. `SHOPPINGLIST_PASSKEYS=off` removes the [§5.4] routes and the RP-ID requirement. Redirect URI: `<app-origin>/api/oauth2-redirect`.
- **Client flow.** The SDK's realtime form (`@oauth2` SSE topic), the provider **popup opened synchronously at click time**. The result populates `pb.authStore` like a passkey finish; [§5.6] and [§5.8] apply unchanged.
- **Provisioning.** The first OIDC login creates the account at system level in PB's exchange transaction (`OnRecordAuthWithOAuth2Request` hook; `accounts.CreateRule` stays superuser-only): **no email** ([D-25]), `verified`, a null `handle` ([§6.1]), and the nickname from the name claim, else the username, else the email's local part, else empty (the client shows a placeholder). **No email auto-merge:** the hook accepts PB's resolved record only when this `sub`'s `ExternalAuth` row points at it. OIDC plus `SHOPPINGLIST_SIGNUP=closed` makes the provider the sole onboarding path.
- **Link** („Mit ‹name› verbinden“). Signed in as A, the user signs in with the provider as B; `POST /api/account/link` carries A's token as Authorization and B's as body `{token}`. If B has **no memberships and no passkeys**, one transaction marks A `verified` first, moves B's `_externalAuths` row and identity label to A, and deletes B; A keeps its id, lists, passkeys and sessions. Otherwise **409**, nothing changes; A already linked, or B without an OIDC login: **400**. Never a merge.
- **`GET /api/auth/methods`** returns `{passkeys: {enabled, signup, signup_by_link}, oidc: {enabled, provider, name, linked, identity}}`. The UI shows each login only while it is on (`SHOPPINGLIST_SIGNUP` gates passkey signup only) and, once linked, „Verbunden mit ‹name› als ‹identity›“. The link route and the last-passkey guard count an OIDC login only while OIDC is on; [§5.8]'s re-auth uses the device's last login while it is on.
- **Identity label** ([§4.4]): the provider's `preferred_username`, else the address it asserted, written at every sign-in to the server-only `oidc_identities` (one row per account), served only to the account itself through `/api/auth/methods`, never in the [§7.4] roster, and deleted with the OIDC login or the account. The client's offline cache of the methods answer drops it with `linked`.
- **Unlink** („Anmeldung entfernen“, whose confirmation says the next provider sign-in creates a separate, empty account). `POST /api/account/unlink` deletes the `_externalAuths` row and label in one transaction; **409** unless passkeys are on and the account has one (race-free with the last-passkey guard), **404** while OIDC is off or the account has no OIDC login. Sessions stay valid; the device's remembered login becomes the passkey.
- **Testing.** Against Dex ([D-154]); the popup inside the installed PWA is manual device testing only ([§5.7]).

---
## 6. Data model (PocketBase collections)

**Syncable** collections (`items`, `list_categories`): `id` is a **client-minted UUID** for a row a sync op creates, a server id for one a [§7.5] route creates; `updated` is **server-stamped** on every write (PB built-in); `deleted_at` is a nullable **tombstone**. `lists` is **not syncable and has no tombstone**: created only by the [§7.5] routes, hard-deleted only by the [§7.3] cascade [D-08]. `memberships` are **not** tombstoned: leaving is a hard delete ([§7]). Items have no `position`/order field. The server-only collections, `merge_log` ([§8.3]), `barcode_cache` ([§9.2]) and `oidc_identities` ([§5.9]), have their rules in [§11] and their fields in their migrations; so does the hidden `deliveries` column on both syncable collections, the last delivered op ids [§8.3] replays from.

### 6.1 `accounts` (auth collection)
| Field | Type | Notes |
|---|---|---|
| handle | string, unique-when-set | identity field; random; password auth disabled. **Null for OIDC-born accounts** ([D-76], [§5.9]). The unique index is partial (`WHERE handle != ''`, 1778000006), since PB stores an unset text field as `''` |
| nickname | string | user-chosen or generated; visible to co-members via the roster route |
| suppressed_names | json | [§6.11]; own-row writable ([§11]) |
| email | string, always empty | PB auth system field, unused ([D-25]; the OIDC label lives in `oidc_identities`, [D-76]); unwritable from the client ([§11]) |
| (PB built-ins) | | tokenKey, verified, etc. |

### 6.2 `credentials` (WebAuthn passkeys, N per account)
| Field | Type |
|---|---|
| account | relation → accounts |
| credential_id | base64url string, unique |
| credential_json | json: the **entire marshalled `webauthn.Credential` struct** (public key, flags incl. BE/BS, attestation, transports, aaguid, sign count), so it round-trips losslessly |
| friendly_name | string |
| last_used_at | datetime |
| user_handle | string, hidden: the WebAuthn user handle the passkey was registered under; login resolves against it ([D-153]) |

### 6.3 Ceremony sessions (not stored)
A passkey ceremony's session lives in server memory, not in a collection ([§5.5], [D-03]).

### 6.4 `lists`
| Field | Type | Notes |
|---|---|---|
| id | 32-hex random | server-minted [D-08] |
| name | string | **the list's one name, shared by every member** [D-08]; capped by the field contract; any member renames it |
| updated | | server-stamped (PB built-in) |

**No owner field. No `deleted_at`.** A list exists exactly as long as ≥1 membership points at it. The one client write is a member's **rename**: a direct update of `name` under the members-only update rule ([§11]), bounded by the lists update guard. The sync engine never carries a `lists` op [D-08]; co-members get the new name from the [§8.5] digest.

### 6.5 `memberships`
| Field | Type | Notes |
|---|---|---|
| id | PB record id | |
| account | relation → accounts | deleted by the account-deletion route ([§4.5]), **not** a relation cascade |
| list | relation → lists | |
| created / updated | | |

No name of its own, no update rule [D-08]; readable only by its owner (the roster route exposes only account, nickname and join time, [§7.4]). Unique index on `(account, list)`. **No `deleted_at`**: leave = hard delete ([§7.2]).

### 6.6 `items`
| Field | Type | Notes |
|---|---|---|
| id | UUID | client-generated |
| list | relation → lists | |
| name | string | the name the server merges duplicates on ([§8.3] [D-29]) |
| name_norm | string, ignored by the client | `normalizeName(name)`, indexed with `list`: the [D-29] merge's lookup key; never in the client schema (dropped by `itemRecordMap` and the client's normalizer) |
| name_de, name_en | **string, nullable** | a **scanned** product's name per UI language ([§9.2]), and the demo's example items' ([D-234]); null on typed items. A member sees their language's, else `name`; **a rename clears both** in the same op. Client-side "already on the list" matching and the typeahead use them; the server's duplicate merge does not [D-21] |
| quantity | **string (free-text)** | |
| note | **string, nullable** | optional remark, edited in the detail sheet ([§9.1]); ordinary field-level sync ([§8.3]) |
| category_key | **string, nullable** | `id` of one of *this list's* `list_categories` rows ([§6.7]), a plain key, not a relation. null **or an unknown/hidden/tombstoned key** ⇒ the list's **Others** category ([§6.12]) |
| checked | bool | |
| checked_at | **datetime, nullable** | **server-stamped by the sync-push route** when an applied op flips `checked` true, nulled when it flips false [D-26]. **Never carried in ops**; the UI shows an optimistic local stamp until the server's arrives. Drives the trip split and newest-first order ([§6.10], [§9]). Besides the push route, clone and import copy it ([§7.5]) and the clear-history route [D-79] bulk-nulls it |
| last_bought_at | **datetime, nullable** | **server-stamped by the sync-push route** to `now()` whenever an applied op flips `checked` true [D-26]; **persists across unchecking**, except for an untick that takes the tick back (`prev_bought_at`, [D-303]). **Never carried in ops.** Dates the previous-items screen and this list's typeahead suggestions ([§6.10]); `null` = never bought, rendered as no date. The [§7.5] clear-history route [D-79] is the only other writer (bulk null); on a **tombstoned** row that purges it from „Frühere Artikel“ and re-arms the [§13] sweep ([D-100]) |
| prev_bought_at | **datetime, nullable** | **ignored by the client**: the `last_bought_at` a tick replaced, so an untick that takes the tick back restores it [D-303]; nulled with it by clear-history. Not in the client row shape |
| barcode | **string, nullable** | EAN/UPC from the scanner ([§9.2]); scan-dedup and re-lookup |
| image_url | **string, nullable** | product-image **URL** ([§9.2]), always a **path on our own origin** (`/api/barcode/photo/{token}`); `img-src` is `'self'` ([D-21]). **Server-stamped from `barcode`** by the sync-push route, import and clone: the photo the lookup stored for that barcode, empty when there is none. **Never carried in ops**; a value an op still carries is dropped ([D-266]). Synced as a URL ([§8.3]), never as bytes; SW-cached. **No per-item icon field** ([§9.1]) |
| modified_by | relation → accounts, **non-cascading** | **server-stamped** by the sync-push route on every applied write; conflict attribution ("‹who› had already set ‹field› to “‹theirs›”."). `cascadeDelete: false`: deleting the account clears it, rendered as "someone" ([§7.4]) [D-32] |
| updated | | PB auto-stamped on every write (feeds the [§8.5] digest `hash` and the merge's `updated` comparisons) |
| deleted_at | **datetime, nullable** | **server-stamped by the sync-push route** [D-45] when an applied op sets `deleted` true, nulled on restore. **Never carried in ops**: clients send a `deleted: true/false` signal ([§8.2]). The [§13] tombstone GC (180d) reads it |

### 6.7 Categories: per-list, copied from a global seed at creation [D-14]

The global **seed** of categories ([§6.12]) is **copied** into a new list's own `list_categories` rows ([§7.5]). From then on they are **ordinary syncable rows the members own**: rename, re-emoji, recolor, reorder, hide, add, all through normal sync ([§8]), with no runtime resolver and no deterministic ids. Later seed edits do not reach existing lists, except a template's new icon ([D-287]) and the one fold of [D-302] ([§6.12]).

**`category_templates` (global, app-seeded, read-only to clients), the seed source only:**
| Field | Type | Notes |
|---|---|---|
| slug | string, unique | **stable, locale-independent id** (`produce`, `dairy_eggs`, `other`), copied onto each list row and referenced by the dictionary's `default_category` ([§6.9]) |
| name_i18n | json | localized names `{ "en": "Produce", "de": "Obst & Gemüse", … }` ([§12.2]); shown by a copied row until renamed |
| icon | string | a single **emoji** |
| color | string | a **palette token** from the curated set [D-37]; the frontend maps tokens to light/dark-safe CSS |
| sort_order | number | default aisle order |
| retired | bool | see [§6.12] |

Seeded on boot ([§6.12]); superuser-only writes. Clients **read** templates but **never write** them ([§10]).

**`list_categories` (per-list, syncable; the list's actual categories):**
| Field | Type | Notes |
|---|---|---|
| id | string | minted once: by the server for the initial copy and route-added rows ([§7.5]), as a **client UUID** for a member's addition |
| list | relation → lists | |
| slug | string, **nullable** | copied from the template for seeded rows (server-owned, [D-08]); **null** for a member-added category. Kept so an un-renamed row renders in the viewer's language and can be reset |
| name | string, **nullable** | **null ⇒ the template's `name_i18n[locale]` via `slug`**; set ⇒ a custom name (plain string) |
| icon | string | emoji, a **concrete** value (copied or picked); freely editable |
| color | string | palette token, a **concrete** value, editable from the curated palette [D-37]; the server caps its length only, and an unknown token renders gray |
| sort_order | number | a **concrete** value (copied); written by the editor's arrange mode ([D-90]) |
| updated / deleted_at | | tombstone ⇒ the category is **hidden** from this list; its items fall back to Others ([§6.6]) |

**Rendering (client-side, [§9]):** this list's non-tombstoned rows, each named `name ?? template[slug].name_i18n[locale]`, sorted by `sort_order`, then name.

- Every row is created exactly once (the initial copy is **one creator in one transaction**, [§7.5]), so ids never collide.
- **A list takes the templates it lacks on request** ([D-251]): `POST /api/lists/{listId}/categories/missing` adds one row per template the list has no row for (a hidden row counts as present), with the template's slug, icon and colour and a null name, after every existing row in template order; nothing existing moves. Online-only.
- **The Others row (slug `other`) cannot be hidden** [D-30]: the sync-push route denies a tombstone op on it ([§8.3]) and the UI offers no hide action; rename, re-emoji, recolor and reorder stay allowed. The aisle order always puts it last whatever its `sort_order` ([D-90]).

### 6.8 `invites`
| Field | Type | Notes |
|---|---|---|
| id | PB record id | |
| list | relation → lists | |
| token_hash | string | **sha256 of the token**, the lookup key ([§7.1]); the token's 32 random bytes ([§10.1]) make a fast hash enough |
| token | string | the live link's token ([§7.1]), read under the member-only rules; empty on links minted before the column [D-294] |
| expires_at | datetime | the link's lifetime ([§7.1]) from the server clock at minting ([§7.6]) |
| revoked | bool | |
| created_by | relation → accounts, **non-cascading** [D-32] | |

### 6.9 `item_dictionary` (global, app-seeded, read-only to clients)

Powers typeahead and auto-categorisation ([§9]). Like `category_templates`: global, seeded, readable by authenticated clients, never client-writable.

| Field | Type | Notes |
|---|---|---|
| id | string | `item_<normalized en name>` ([§6.12]) |
| names_i18n | json | `{ "en": ["cucumber"], "de": ["Gurke", …], … }`; `[0]` is the display form, the rest synonyms; locale-aware prefix matching ([§9], [§12.2]) |
| default_category | string (template slug), **nullable** | pre-fills a known item's aisle; the user can override |
| popularity | number | typeahead ranking; a coarse hand-assigned tier |

Clients mirror it into Dexie so typeahead works **offline**; the mirror is refreshed when the server's `seed_version` advances ([§6.12]).

### 6.10 Previous items (checked-item history, no separate collection)

There is **no `purchases` collection** [D-18]: a checked-off item stays in `items`. No purchase log, counts or analytics. **`items.checked_at` ([§6.6]) buckets checked rows** [D-26]:

| `checked_at` vs. the list's **current trip** | Bucket | Where it shows |
|---|---|---|
| **on it** | recently checked | the **shop view's** „Erledigt“ section only, newest first; tap to restore |
| **before it** | previous items | the per-list **„Frühere Artikel“** screen; tap to re-add |

**The current trip** is the list's run of check-offs with **no pause of three hours or more** between two of them (`TRIP_GAP_MS`), while the newest is less than three hours old, judged over the whole list from the server stamp [D-18].

**A checked row whose `checked_at` is missing counts as long-since-checked**: previous items, sorted last in the default last-purchased order, never the done section [D-79]. Only „Kaufdaten zurücksetzen“ ([§7.5], at the foot of „Frühere Artikel“ while any row carries a date, [D-271]) produces this state.

Both buckets are **client-side view filters over `items`**; nothing moves in storage. An open view re-sorts when the trip ends (`#lib/state/clock` ticks then and when the tab becomes visible).

- **Re-adding** clears `checked`/`checked_at` (not `last_bought_at`) and puts the same row back on the active list as a **new entry**: no old quantity; the note comes back only when re-added from „Frühere Artikel“, not from the add bar or scanner ([D-200]).
- **Restoring** from recently-checked undoes this trip's check-off and keeps every field.
- **Removing** (tombstone, [§8.2]) is distinct from checking off. A removed row **with** a `last_bought_at` stays in previous items; one **never bought** never appears there ([D-18]). The predicate lives in `frontend/src/lib/sorting.ts` (view, client dedup), mirrored by `remembersPurchase` in the [§8.3] merge.
- **Per list, kept indefinitely.** [§13]'s 180-day tombstone sweep skips tombstoned `items` carrying a `last_bought_at`; clearing the stamps ([§7.5]) returns them to it ([D-100]).
- **No conflict logic.** Check/uncheck rides the field-level merge ([§8.3]); `checked_at` is stamped outside it, so it cannot conflict or toast [D-26].
- Previous items feed this list's derived typeahead picks ([§9]).
- **`last_bought_at` is shown** only on the **previous-items row** and this list's own **typeahead suggestions**, whenever there is a stamp, as a relative date in **calendar days** (*heute* / *gestern* / *vor 3 Tagen*, as `Intl.RelativeTimeFormat` words them; `daysAgo` floors both ends to local midnight) [D-18]. Never on a **dictionary** suggestion, the planning row or the shop tile. [D-29] preserves it when it re-activates a row.

### 6.11 Suggestion suppression (account-bound preference) [D-17]

Behind **„Nicht mehr vorschlagen“** ([§9]): a suppressed name leaves the typeahead's *union* (dictionary hits and derived picks alike) **without** erasing history.

**Not a collection, not synced through the outbox.** A **global, per-account** list of normalized names in `accounts.suppressed_names`, written through PocketBase's ordinary **own-row** path ([§11]), never `sync/push`, and **mirrored in Dexie** so it applies offline. Each change is kept as a **pending intent** (name → add/remove) until the server confirms it; the mirror is the last confirmed server copy with those intents applied ([D-137]). Delivery applies the intents to the account's current server list, so another device's names survive; it is retried on the next change, at app start, on reconnect and after re-auth. A refused write drops its intents, falls back to the server copy and says so. Simultaneous writes from two devices are last-write-wins.

**Un-suppression:** **explicitly re-adding** a suppressed name removes it, and the settings' hidden-suggestions sheet restores names.

### 6.12 Seeding of global reference data (`category_templates` + `item_dictionary`)

Both are populated only by an **idempotent boot seeder**, never by hand or client writes (superuser-only, [§10]) [D-15].

- **Embedded, offline-safe.** `backend/seed/categories.json` and `backend/seed/items.json` are compiled in via Go `embed`; a fresh boot seeds with no network.
- **Idempotent upsert, gated on `seed_version`.** `category_templates` upsert **by `slug`**; `item_dictionary` **by a deterministic `id` from the canonical `en` name** (`item_cucumber`). Re-running never duplicates ([§18]). Re-application is gated on a `seed_version` in PocketBase's `_params` table (`backend/seed/seed.go`), so superuser edits survive until the next bump. A bump applies in one transaction with the stored version, so an interrupted one is redone in full; the log says when it starts and how long it took.
- **What a bump does to existing lists.** A template whose icon changes moves every list's category still on its old icon, and leaves one changed by hand ([D-287]). The boot that crosses seed version 8 folds every list once into [D-300]'s aisles (`seed/fold.go`, [D-302]).
- **Client re-mirror on version bump.** `GET /api/seed-version` exposes the active version to authenticated clients. The client stores its mirror's version in `meta.seed_version` and compares after the **first completed pull of each session**, retrying each cycle until it succeeds; if they differ (or the local dictionary is empty), it re-pulls both collections in full and replaces the mirror, refusing an empty fetch.
- **Shape.** Template `icon` is stored and synced as the emoji character, drawn with bundled OpenMoji artwork ([D-181], [§9.1]). A `retired` template is no longer copied into a list, offered to one or used by a text import; it still names the rows lists have and lets a backup carrying its slug import [D-300]. Dictionary fields: [§6.9].
- **Default category seed**: walk order through a German supermarket then errands, colours by meaning with neighbours apart ([D-251], [D-300]); copied into each new list at creation ([§7.5]) and editable per list ([§6.7]).

<!-- category seed (rendered from backend/seed/categories.json by its test) -->
| # | Emoji | Color | Deutsch | English | slug |
|---|---|---|---|---|---|
| 1 | 🥦 | `green` | Obst & Gemüse | Produce | `produce` |
| 2 | 🥖 | `amber` | Brot & Backwaren | Bakery | `bakery` |
| 3 | 🥛 | `sky` | Milch & Kühlregal | Dairy & Chilled | `dairy_eggs` |
| 4 | 🥩 | `red` | Fleisch & Fisch | Meat & Fish | `meat_fish` |
| 5 | 🥫 | `olive` | Konserven & Vorräte | Pantry & Canned | `pantry` |
| 6 | 🍝 | `yellow` | Nudeln, Reis & Getreide | Pasta, Rice & Grains | `pasta_rice` |
| 7 | 🧁 | `brown` | Backen & Gewürze | Baking & Spices | `baking_spices` |
| 8 | 🥣 | `pink` | Frühstück & Müsli | Breakfast & Cereal | `breakfast` |
| 9 | 🍵 | `lime` | Tee, Kaffee & Kakao | Tea, Coffee & Cocoa | `coffee_tea` |
| 10 | 🍫 | `violet` | Snacks & Süßigkeiten | Snacks & Sweets | `snacks_sweets` |
| 11 | 🥤 | `teal` | Getränke | Beverages | `beverages` |
| 12 | 🍷 | `wine` | Bier, Wein & Spirituosen | Beer, Wine & Spirits | `alcohol` |
| 13 | ❄️ | `cyan` | Tiefkühl | Frozen | `frozen` |
| 14 | 🧴 | `lavender` | Drogerie & Körperpflege | Personal Care | `personal_care` |
| 15 | 🧻 | `slate` | Haushalt & Reinigung | Household & Cleaning | `household` |
| 16 | 🍼 | `blue` | Baby | Baby | `baby` |
| 17 | 🐾 | `indigo` | Tierbedarf | Pet | `pet` |
| 18 | 💊 | `magenta` | Apotheke | Pharmacy | `pharmacy` |
| 19 | 🔨 | `orange` | Baumarkt & Garten | Hardware & Garden | `hardware` |
| 20 | 🛞 | `steel` | Auto & Fahrrad | Car & Bike | `car_bike` |
| 21 | 📦 | `gray` | Sonstiges | Other | `other` |

Retired: 🪴 `lime` Garten & Pflanzen / Garden & Plants (`garden`).
<!-- category seed end -->

`garden` is retired into `hardware` [D-300]. Slugs are permanent. **Others** (`other`) is an **explicit** seeded category that sorts last and is the fallback for any null/unknown `category_key` ([§6.6]); there is no implicit uncategorized bucket. `items.json` covers de/en and every category but `other`, which seeds no dictionary entries.

**Content is hand-curated, never bulk-imported** from a grocery database [D-24]; this holds for the [§6.13] tooling too.

### 6.13 Operator content-curation tooling [D-34]

Growing the global taxonomy is an **operator** action ([D-15]) with two tools that add no DB-write path, collection, HTTP route or admin-UI mutation.

- **Additive seed-append command** (`cmd/appendseed`, outside the compiled binary; edits only the checked-in seed files): derives each `item_dictionary.id` exactly as the boot seeder does (`item_<normalized-en-name>`, [§9] [D-44]), categories by `slug`; appends only entries whose id/slug is not already in `seed/items.json` / `seed/categories.json` (an id-string check, not a semantic one); bumps `seed_version`. The seed is embedded, so a **rebuilt and redeployed binary** applies it at its start ([§6.12]).
- **`./shoppinglist dictionary-suggestions`**, a read-only CLI subcommand on the binary, run over SSH. It normalizes the names of non-deleted `items` across all lists with the **app's own normalization function**, the one the duplicate merge uses ([§9], [D-29], [D-44]); keeps those matching no `item_dictionary.names_i18n` entry; groups them by normalized name, counting **distinct lists** and dropping groups below a threshold (e.g. 3 lists); and prints the groups by list count, descending, each with its **per-category occurrence counts** (`items.category_key → list_categories.id → slug`; a `slug`-less custom category is labelled as such), not one collapsed guess:
  ```
  "kiwi"       (5 lists)  produce: 4, snacks_sweets: 1
  "hummus"     (4 lists)  pantry: 2, dairy_eggs: 1, other: 1
  ```
  The operator curates its output ([D-24]) into the append command.


---

## 7. Sharing & membership model

- **No owner; all members are equal:** any member edits items and categories, invites, sees the roster (account id + nickname: identities are not private), renames the list (one name for all, `lists.name` [D-08]) and leaves.
- **No one deletes a list directly**; it goes when its **last member leaves** ([§7.3]). No one can evict a bad actor; others can only leave.

### 7.1 Invite lifecycle (link-only)

- **One reusable link per list**, live until expiry (**30 days**) or revocation. Any member may share, reset (rotate), revoke or create it; revoking blocks new joins without evicting anyone. **Any member's departure revokes it** ([§7.3]) [D-31].
- The token is **minted server-side** ([§10.1]) and looked up by its sha256 hash; a live link's token is kept beside the hash for every member to share, and a revocation blanks it [D-294]. It travels in the **URL fragment** (`#…`), never in access logs or Referer headers; the SPA POSTs it to the [§7.6] routes.
- **The server holds one active link per list**: a partial unique index (`ON invites (list) WHERE revoked = 0`) plus atomic rotation in the mint route [D-31].
- The **"Share & members" sheet** shows the roster ([§7.4], no avatars [D-57]) above the live link, with „Link zurücksetzen“ and „Link zurückziehen“ [D-310]; without a live link it offers „Link erstellen“, and opening it never mints [D-330].

### 7.2 Leave = hard delete

Leaving **hard-deletes** the caller's own membership row (PB `delete`, own row only). Memberships are **never tombstoned**: the leaver's device removes the list on a successful leave, so no offline replay resurrects it, and every rule reads *a membership row exists ⇔ access exists*.

### 7.3 Last-one-out cascade

An `OnRecordDeleteExecute` hook on `memberships`, **inside the delete's own transaction**, after the row is gone, so a failed cascade rolls the leave back and no list is left without members:

1. Revoke the list's live invite link [D-31]. Count remaining memberships; if > 0, done.
2. If 0, **hard-delete** the list's `items`, `list_categories`, `invites`, `merge_log`, then the `lists` row.

Concurrent leaves are safe: SQLite serialises them, each hook counts in its delete's transaction, and exactly one sees zero.

A device's queued ops for a list it no longer belongs to come back `denied`/`not_member` (membership is checked before existence) or `gone`. Neither is retried or reported as a failed change: the client runs a full cycle at once, and [§8.6] removes the list with one neutral notice [D-138].

### 7.4 Member roster (custom route)

`GET /api/lists/{listId}/members` (auth + membership) returns `[{account, nickname, joined}]`. It is the **only** exposure of member identities; `memberships` reads stay own-rows-only ([§11]), so SSE cannot carry roster changes. The client caches it in Dexie and refreshes it at **four triggers** [D-236]:

- **(a)** per list, on its **first drain of each session** (a failure retries next cycle), and at once on a join, without holding the join;
- **(b)** when the Share & members sheet opens, every 5 s while open (skipped offline or hidden), and once as it closes;
- **(c)** **on miss**: a conflict notice ([§8.4]) naming an uncached member fetches once more, then falls back to "someone" (e.g. a deleted account, [§4.5]);
- **(d)** when the leave dialog opens ([§7.2]): its confirm stays busy until the read answers, since the roster decides whether it warns that leaving deletes the list for everyone.

Every other reader, the home's member count ([§9.3]) and the list header's member line among them, reads the cache only. Between triggers the cache may lag.

### 7.5 List creation (custom route)

`POST /api/lists` `{name}`, in one transaction: the `lists` row, the creator's membership, and a **copy of `category_templates` into `list_categories`**, one row per non-retired template with its `slug`/`icon`/`color`/`sort_order` and a **null `name`** (the localized default until renamed, [§6.7]). It is outside the outbox, so **list creation requires connectivity** [D-09] ([§9.3]).

Two variants build a populated list the same way, in one transaction [D-72]:

- `POST /api/lists/{listId}/clone`: source is a list the caller is a member of ([D-74] gate); `{name}` is required.
- `POST /api/lists/import`: source is a validated backup file, or one the client built from a pasted or shared text list ([D-254], [§9.3]); `{name}`, else the file's name. A blank name is refused. The server holds no UI text.

**These three routes are the only way a list is made** [D-08]. They mint the list id and every copied row's id server-side, ignoring any body `id`; ids a push op creates stay client-minted ([D-42]). **`list_categories.slug` is server-owned**: import accepts only `category_templates` slugs, at most one row per slug, and a member-added row's null slug stays null. Capped columns take their bound from the [§8.3] field contract on every writer.

Clone and import copy the list as it stands, `checked`, `checked_at` and `last_bought_at` included (the never-in-ops rule, [§8.2], binds client ops, not routes), but never tombstoned rows, record ids, created/updated stamps or members; `modified_by` is the caller. The backup envelope (format tag, **one accepted version**, row caps) is in the [§8.3] field contract; any other version is refused, not migrated [D-72].

`POST /api/lists/{listId}/clear-history` [D-79] nulls `checked_at` and `last_bought_at` in one transaction on every item carrying either, **tombstones included** (such a row leaves „Frühere Artikel“, [§6.10], and its [§13] GC re-arms [D-100]); `checked` is untouched. `RequireAuth` + [D-74] gate, byte-identical 403 for non-member and nonexistent list. Response `{"cleared": n}`, exactly the items whose stamps (and `updated`) changed ([§8.5]). The caller nulls both columns in its Dexie mirror as a local settle, never an op.

### 7.6 Join / preview flows

**No anonymous editing at any point: editing always requires account + membership.**

- `POST /api/lists/{listId}/invite` (auth + membership, rate-limited): rotates the single active link (revoke + issue in one transaction) and returns the raw token **once**: `{id, list, expires_at, revoked, token}`. `created_by` comes from the caller's token, `expires_at` from the server clock; neither is settable from the body [D-31].
- `POST /api/lists/{listId}/invite/revoke` (auth + membership, rate-limited): revokes the live link. Idempotent.
- `POST /api/invites/preview` `{token}` (no auth, rate-limited): validates hash/expiry/revocation; returns a **read-only snapshot** (list name, item names/quantities, member count).
- `POST /api/invites/join` `{token}` (auth, rate-limited): creates the membership, or no-op success if already a member. The invite stays valid. The client then syncs; the new list has no local digest, so the first probe ([§8.5]) pulls it [D-28].

A recipient without an account sees the preview, then the auth screen's account step (account creation first, [§5.4]), then joins [D-265] [D-297]. The token stays in the address bar until the join replaces the history entry [D-295], and in the tab's `sessionStorage` for a reload. The join screen shows one message for every refusal (400: invalid, expired, revoked), whose way out drops the token, and a retry for a request that got no answer [D-292].

The token is an **invitation, not a credential**: it grants nothing until the recipient authenticates; a leak exposes one revocable preview.

---

## 8. Offline-first sync engine

A custom, heavily unit-tested engine [D-10]. The app enters it only through `#lib/sync` (`src/lib/sync/index.ts`); lint refuses deep imports [D-220].

### 8.1 Conflict policy [D-11]

**First-committed-wins, per field.** When both sides changed the *same field* to *different values* from the same base, **the value already committed on the server wins**, and the late side gets a passive toast ([§8.4]). Concurrent edits to *different fields* of a record merge cleanly. Neither the server's wall clock nor a client's clock ever decides a winner.

**The unit of possible loss is one field on one record, never a list or trip** (a duplicate *name* merges, [§8.3] [D-29]; `checked_at` is server-stamped, [D-26]). Bulk work vanishes only outside the policy: a deleted list ([§8.6], with a notice) or eviction before sync ([§8.8]).

### 8.2 Outbox pattern (client)

0. **Two copies of every record [D-40].** The **shadow** (`server_items`, `server_list_categories`) is exactly the last server state of each row, written by every inbound path and every push result, never by a local edit. The **view** (`items`, `list_categories`) is what screens read, always `materialize(shadow, op)`: the shadow, then the op's in-flight layer, then its pending layer. A record with no op shows its shadow exactly.
1. Every event (a local mutation, an inbound write, a push result) changes one input and recomputes the touched rows **in one Dexie transaction** over view, shadow and `pending_ops`: an edit shows at once, and row and op never disagree.
2. **Op shape (wire):**
   ```jsonc
   {
     "op_id": "uuid",              // matches results to ops; with the payload, names a delivery [D-42]
     "collection": "items" | "list_categories",  // lists is never in an op [D-08]
     "record_id": "id",            // a create's: 8-64 of [A-Za-z0-9_-]
     "list_id": "id",              // scope key: lets the client drop ops when a list is gone
     "type": "create" | "update",  // delete = update {deleted: true}; restore = false [D-45]
     "changed": { "field": newValue, ... },   // `deleted` rides here as a boolean signal
     "base":    { "field": baseValue, ... },  // shadow value when the field was first edited (create ⇒ {})
     "queued_at": "local ISO time"  // drain order only; never used by the server
   }
   ```
   Stored, an op has **two layers**: `changed`/`base` are the **pending** layer, `inflight` is the payload on the wire, frozen when sent. Each layer keeps optimistic `stamps` for the server-stamped columns its edits set (`checked_at`/`last_bought_at`, `deleted_at`), shown by the view, never sent.
   **Base:** the shadow's value of the row the person acted on, at the field's *first* edit, never read at send time; for a field in flight, the in-flight layer's base. **`checked_at`, `last_bought_at` and `deleted_at` never appear in `changed` or `base`**: the push route stamps them ([§8.3], [D-26], [D-45]).
3. **Coalescing:** further edits merge into the op's pending layer; `changed` updates, `base` keeps first-edit values. The in-flight layer is never touched. One record ⇒ at most one pending op from its own edits; a `merged` remap can briefly add a second, applied in queue order.
4. **Tombstone deletes [D-12]:** delete enqueues `update {deleted: true}`, restore `{deleted: false}` [D-45]; the server stamps `deleted_at`. **The client never hard-deletes syncable records**; hard deletion happens only via the [§7.3] cascade and [§13] GC.
5. The **sync loop** (leader tab only, [§8.7]) decouples outbound from inbound:
   - **Outbound:** every local mutation while online triggers a full drain in `queued_at` order, **debounced ~500 ms**, chunked to the push limit ([§8.3]).
   - **Inbound, digest-gated [D-28]:** on app start, focus or a tab returning to screen, on `online`/reconnect, and on a **~60 s idle tick skipped while no app tab is visible**, with **one retry 5 s after a failed cycle** [D-164], the leader runs the digest probe ([§8.5]) and pulls only diverged lists. SSE gives freshness in between.
6. **Drain and settle [D-40].** The drain re-sends an op's **in-flight layer** unchanged until a result settles it, else promotes pending to in-flight.
   - **Every settling result** (`applied`/`partial`/`noop`/`merged`/`deleted_conflict`) **carries the server `record`, which becomes the shadow**, and ends the in-flight layer. Pending edits stay queued: one on a field whose in-flight value the server took is re-based onto the record; one built on an in-flight value the server refused keeps that layer's base and is refused in turn.
   - On `merged` the record becomes the **surviving** row's shadow and **queued ops are remapped from the dead UUID to the returned `record_id`** before the drain continues.
   - `denied` drops the in-flight layer (a denied create, the whole op, [§8.4]); `gone` purges the list ([§8.6]).
   - An op is removed once no layer is left. It is **kept and retried on network failure and when the server omits it from the results**; a retry re-sends exactly what may have been committed, and the server answers it from its first delivery ([§8.3] [D-42]).

### 8.3 Push endpoint & server-side merge

`POST /api/sync/push` `{ops: [...]}`: auth required, at most **500 ops per request** (`max_ops_per_push`, field contract), each `op_id` at most 64 bytes [D-108]; either over is a 400 for the whole request. It is the **only write path** for `items` and `list_categories`; their PB create/update/delete rules are `null`, so the route is the single enforcement point (`lists` is outside sync; its one client write is a member's rename through the collection API, [§11] [D-08]). Each op runs in its own transaction:

1. **Authorise:** the caller must be a member of `list_id` and the record must belong to that list; else `denied`.
2. **`create`:**
   - `record_id` already exists (re-delivery) → `noop` with the current record; the merge is **not** re-run [D-42].
   - `record_id` is not 8-64 of `[A-Za-z0-9_-]`, or names another list's row or another list's `merge_log` entry → `denied`/`bad_record_id`, and that list's row is left alone [D-191].
   - The list no longer exists → `gone`; no orphan is stored ([§8.6]). A deleted list usually answers `denied`/`not_member` at step 1 instead, the cascade having deleted the memberships, and the cycle's membership set notices it ([§8.5], [D-138]).
   - A create that would add a row past the list's items or categories cap ([§10]) → `denied`/`list_full` [D-217].
   - `items` create whose **normalized name** ([§9]) matches a **non-tombstoned** item (checked or not; of several, the oldest by `created`, the lower `id` within a millisecond) → **not inserted**; `merged` with the existing row's `record_id`, the discarded id logged in `merge_log` so a retry replays the answer [D-108]. The existing row keeps its fields, **except a re-activated row** (checked, or a remembered tombstone): it gets `checked` = false, `checked_at` = null unless the create checks it (`last_bought_at` persists, [§6.6]) and takes the create's `quantity` and `note`, reporting no conflict for them [D-200]. A living row's blank `quantity`, `note` or `barcode` takes the create's value, reporting no conflict, a filled barcode with its photo [D-29], [D-266]. Otherwise each field where the create carried a **non-empty, differing** value is reported in `conflicts` (`{field, mine, theirs, theirs_by}`) for the [§8.4] toast; none otherwise [D-29].
   - A **tombstoned** row matches **only if it carries `last_bought_at`** (it is a previous item, [§6.10]); the merge then nulls its `deleted_at`. A never-bought tombstone does not match and the create inserts fresh [D-18].
   - Else insert, stamp `modified_by` = caller (and `checked_at`/`last_bought_at` if inserted checked, see 3) → `applied`.
3. **`update`:** load the record. Missing: if the **list** is gone ([§7.3]) → `gone`; if the list lives (GC swept the row) → `denied`/`row_missing` [D-103] ([§8.6]).
   - **A delivery already decided** (the same `op_id`, `changed` and `base`, among the row's last 8 non-denied, non-merged verdicts, kept in its hidden `deliveries`) → nothing applies again: `noop` with the current record, or `partial` listing each field whose value differs now [D-42].
   - Sets `deleted` true on the `list_categories` row with slug `other` → `denied`: Others is permanent ([§6.7], [D-30]).
   - Tombstoned and the op **sets `deleted` true** → **convergent delete**: `noop`, no conflict (other coalesced fields are moot). **Except a check-off** [D-175]: an `items` op that also sets `checked` true stamps `last_bought_at` = `now()` on the tombstone (which stays removed, `checked` untouched) and answers `applied`, so the purchase reaches „Frühere Artikel“ ([§6.10]).
   - Tombstoned, the op **clears `deleted`** (a restore), and a **living** `items` row with the same normalized name exists → **restore-merge** [D-176]: the tombstone stays; the living row survives by the create-merge rules above but keeps its own quantity and note, and takes the tombstone's `last_bought_at` if newer, which the tombstone loses. `merged` with the survivor's `record_id`, logged in `merge_log` under the tombstone's id and the op's `op_id` [D-108]: a retry of the same op replays, a later restore by another op is decided anew. Without a living twin the restore lifts the tombstone as below.
   - Tombstoned and the op does not clear `deleted` → not applied; `deleted_conflict` with `{theirs_by}` ([§8.4]).
   - Otherwise, **per field `f` in `changed`** (excluding the `deleted` signal):
     - `current[f] == changed[f]` → no-op;
     - `current[f] == base[f]` → **apply**;
     - else → **conflict:** keep `current[f]`; record `{field: f, mine: changed[f], theirs: current[f], theirs_by: current.modified_by}`.
   - **`deleted` signal [D-45]:** true stamps `deleted_at` = server `now()`; false nulls it.
   - An applied `checked` flip stamps `checked_at` (`now()` on true, null on false) **and** `last_bought_at` (`now()` on true, **kept on false**) [D-26]. A tick keeps the date it replaced in `prev_bought_at`; an untick whose op carries the signal **`bought: false`** (the undo of a tick, a put-back from the done pile) restores it, while `last_bought_at` is still that tick's own [D-303]. `bought` is a signal like `deleted`, never a column, and a re-add's untick does not send it.
   - If ≥1 field applied (or `deleted` flipped): stamp `modified_by` = caller and save (PB bumps `updated`, firing SSE).
4. **Result per op:** `{op_id, status: "applied" | "partial" | "noop" | "merged" | "denied" | "gone" | "deleted_conflict", conflicts: [...], record_id?, record?, reason?, field?}`. `record_id` on `merged` is the survivor's id. **`record` (the authoritative server row) comes with every settling result** and is omitted on `gone` and `denied` ([§8.2] step 6). `conflicts` is toast copy only; the server has already decided. **Every `denied` carries a `reason`** (+ `field` where one applies): `bad_collection` / `bad_list` / `bad_type` / `field_unknown` / `field_invalid` (a value of the wrong JSON type, each writable field having one: `checked` a boolean, `sort_order` a whole number, the rest a string or null) / `field_too_long` / `not_member` / `wrong_list` / `protected_row` / `bad_record_id` / `row_missing` / `list_full` (listed in the field contract) [D-40].

**The field contract** (`backend/internal/fieldcontract/field-contract.json`) is the one shared artefact for the writable-field allowlist, per-field byte caps, push limit, reason codes and backup envelope: the Go route embeds it and the frontend imports it [D-40], like `seed/digest-vectors.json` and `seed/normalization-vectors.json` ([§9]).

The client engine has no per-collection machinery: previous items are ordinary `items` rows ([§6.10]) and suggestion suppression lives outside sync ([§6.11]). Besides the list cap [D-217], the route has **five special cases**, each a small unit-tested branch ([§14]): the `merged` create [D-29], the restore-merge [D-176], the Others protection [D-30], `checked` stamping [D-26] [D-175], and `deleted` stamping [D-45]; the rest is the general merge.

### 8.4 Conflict UX (client) [D-11]

`partial`, `deleted_conflict`, and a `merged` create that discarded a differing value [D-29] raise a **passive, non-blocking toast** naming the item and, for a lost value, the member whose value stands (`theirs_by`, from the roster cache, [§7.4], fallback "someone"), and nothing else: no re-apply, no modal. A merge that discarded nothing shows nothing. The winning value is already in the result's record ([§8.3]); a `deleted_conflict` settles the in-flight layer like any other result, and the tombstone becomes the shadow. Notices queue apart from the undo toast's slot, each shown for the full timeout, and reach every open tab, not only the leader that raised them [D-293].

**`denied` follows the same rule** [D-40]. A denial is terminal: the client **drops the refused layer**, recomputes the row from its shadow (so the refused value, stamps and tombstone included, disappears), and shows a passive one-liner chosen by `reason` (`list_full` has its own, for an item and for a category; an unknown reason gets the generic line). A denied *create* takes the whole op and the row. Edits made after the refused push stay queued for their own push. A `not_member` denial is silent and runs a full cycle at once ([§8.6], [D-138]).

### 8.5 Inbound changes

Three layers: freshness, a consistency probe, and a repair authority [D-28] [D-40]. **Inbound never touches an op:** SSE, delta and snapshot write shadows only, each apply in **one Dexie transaction that reads the ops inside it**, so an op enqueued during a slow fetch still shows on its row.

- **SSE (freshness)**: PocketBase realtime subscriptions, scoped by read rules ([§11]), applied at once (idempotent upsert by id). An event whose `updated` is older than the row's shadow is dropped, so a shadow never goes back. Non-authoritative: the probe and snapshot correct anything stale, reordered or echoed. A failed subscription for the on-screen list is retried after the next completed cycle [D-164]; an active one is reused and an attempt in flight joined, never duplicated.
- **Digest probe (consistency)**, on the triggers of [§8.2] step 5: `GET /api/sync/digest` → `[{list_id, row_count, max_updated, hash, name, membership}]` for all the caller's lists. The client hashes its **shadow** the same way (sorted `{id}:{updated}` pairs, tombstones included; `seed/digest-vectors.json`). **A match means in sync: no pull.** `row_count`/`max_updated` are diagnostics. The digest is **stateless**: no cursor, no stale-device rule. It is sound only because every server write bumps `updated` or changes the row set: a write to an `items` or `list_categories` row moves its `updated` past the stored one, a millisecond ahead of the clock when it has not moved on, since two writes in the same millisecond would change the row but not its pair.
- **Snapshot (repair authority) [D-173]**, only for diverged lists (and for all lists after eviction, [§8.8]). Cheapest first, **re-digesting locally after each step** and stopping on a match:
  1. if the server's `max_updated` is newer than the local one, a **tail-catchup delta** (`updated > localMax` for both tables), upserted into the shadows;
  2. the list's **id set**, which drops every shadow and row whose id the server no longer has (a GC or admin hard delete changes the hash but not `max_updated`);
  3. the **full snapshot**, for a mismatch neither explains: the list's complete current state (all `items` and `list_categories`, **every tombstone GC has not swept included**). Every server row becomes its shadow and every shadow the server no longer lists goes.

  All three go through **`GET /api/sync/snapshot/{listId}[?since=…|?ids]`** (`RequireAuth` + the [D-74] membership gate): a rejected token (401) or lost membership (403) aborts before any sweep. Through the view rule, a row with a queued *create* stays, and a row whose server copy is gone goes even with a queued update, whose push then answers `row_missing` ([§8.6]). A joined list is hydrated by its first diverged digest.
- **Own memberships arrive in full every cycle on the digest response [D-28]**: each entry carries the caller's own membership row (the entries *are* the membership set) and the list's `name`, which is how a rename propagates [D-08]. Memberships and cascaded lists are hard-deleted ([§7.2], [§7.3]), so a missing membership ⇒ [§8.6] cleanup; this is how a device learns a list vanished. **An empty answer is authoritative**: a rejected token is a **401**, which expires the session and aborts before any purge ([§5.8]). A response whose entries are not membership-shaped aborts the cycle like a network failure.
- **Volume:** a list grows by its history and tombstones up to the item cap [D-217]. Steady state is one small digest call per ~60 s while on screen; the daily GC costs each device of a swept list one id set, not a snapshot.

### 8.6 `gone` handling

On `status: "gone"` or the membership set ([§8.5]) showing the list vanished (usually the latter, after a `not_member` denial triggers a full cycle, [D-138]): drop all `pending_ops` with that `list_id`, delete the list and its records from Dexie, and show the [§7.3] notice, named from the local `lists` row read before the purge. Never retry.

**`gone` means the list is gone** [D-103]. A push against a missing row on a **living** list answers `denied`/`row_missing`, a terminal denial ([§8.4]); a single swept row never triggers a whole-list purge. A `create` for a nonexistent list answers `gone` ([§8.3]).

### 8.7 Multi-tab / multi-context coordination

PWA windows and browser tabs share one IndexedDB. **Exactly one sync loop runs** [D-13]: the holder of the Web Lock `"sync-leader"` (`navigator.locks.request`) leads and drains the shared outbox; other tabs enqueue ops and read via Dexie `liveQuery`. Leadership hands over when the leader closes. A leader the browser suspends in the background keeps the lock and is never stolen from; when a list's edit has waited 20 s with no exchange started, a follower says to close the other tab ([§12.1], [D-288], [D-296]).

### 8.8 Local storage durability

- Call `navigator.storage.persist()` on every app start (best-effort; iOS can evict IndexedDB of non-installed web apps after ~7 days of disuse).
- The passkey lives in the **OS keychain** and survives eviction. After eviction: passkey re-auth (one tap) → full re-pull (the [§8.5] snapshot for all lists). **Local data is never the sole source of truth for anything on the server**: only un-drained outbox ops are unique to the device, and losing them to eviction is an accepted edge.

---

## 9. Display, sorting, item entry & history

Categories exist for **ordering** the store walk, not for labelling. A list's categories are its own `list_categories` rows, copied from the global seed at creation and edited in place ([§6.7]); there is no runtime resolver.

**Name normalization ([D-44]).** Every item-name match (the server's duplicate-create merge, [§8.3] [D-29]; typeahead dedup, [§9.1]; suggestion suppression, [§6.11]; the dictionary's prefix match; the operator CLI, [§6.13]; the boot seeder's ids, [§6.12]) compares one form: **trim → NFKC → lowercase → collapse internal whitespace runs to one space**, in that order, with **no de-umlauting and no ß→ss**. Go and TypeScript implement it, both held to `seed/normalization-vectors.json` (`[{in, out, note}]`: umlauts, ß, NFC/NFD, full-width digits, odd spaces, case, emoji, the empty string).

**Sort.** Unchecked items first, by category `sort_order` then `name`, or A→Z ([§9.1]). An item whose `category_key` is null, or points at a hidden, tombstoned or missing row, falls into the list's **Others** category ([§6.6]), last.

**Typeahead ([§6.9]).** The add field lives in the **list view only**, with the scan button inside its end ([§9.2], [D-277]). Suggestions are read locally from Dexie: the global `item_dictionary` (current-locale `names_i18n` + synonyms, prefix match), **union** this list's own item names (active, recently checked and previous, [§6.10]) ranked by server-stamped `updated`, **minus** the account's suppression list ([§6.11]).
- **A selected dictionary hit** creates the item with its localized name and `category_key` = the list's category whose `slug` matches the entry's `default_category`.
- **The as-typed add is always a row** at the dropdown's foot, over its head-noun aisle guess ([D-332]), except when a suggestion is exactly the typed name ([D-305]).
- **Enter accepts the top match**: the auto-highlighted first suggestion, or one that is exactly the typed name. It adds as typed only when the as-typed row is the only candidate or the suggestions are closed.
- **An amount typed before or after the name is the quantity** ([D-285], [D-200]).
- **While the dropdown is open, a scrim puts the list behind it out of reach** ([D-131]); a tap on it only closes the typeahead and keeps the text.
- **„Nicht mehr vorschlagen“** on any suggestion adds the normalized name to the suppression list ([§6.11]), leaving history untouched. Adding a suppressed name by hand removes it again, as does the settings' „Ausgeblendete Vorschläge“ row.

**Head-noun auto-categorisation ([D-48]).** A create that is not a selected dictionary hit, and would otherwise have a null `category_key`, gets its aisle by **longest-suffix match** against the mirrored `item_dictionary` (all locales) and this list's own categorised items, which rank first. No match ⇒ **Others**. It runs only on the client (no route, schema or request), shows in the optimistic render, and is silent and overridable on the row's category chip. It folds umlauts, ß and punctuation, so it is a separate helper on top of `normalizeName`, and nothing it computes reaches dedup, suppression or `sync/push` ([D-221]).

**Category assignment** is a picker of the list's categories ([§6.7]). **Aisle order is per-list**, set by any member in the category editor's arrange mode ([D-90]); it writes `sort_order` ([§8]). There is **no per-item drag-ordering** ([D-19]).

**No clearing step.** A checked item stays in the shop view's „Erledigt“ section for the current **trip**, then moves to the per-list **„Frühere Artikel“** screen ([§6.10]). Nothing is swept and no cron runs: it is a client-side, time-based view change, and each age shows in one place only.

**Previous items screen (per list).** A sub-screen whose ‹ goes back to the list ([D-304]). Its rows are the list's checked items from earlier trips ([§6.10]), each **dated** with the relative day bought ([D-18]) and each a one-tap **re-add**: it clears `checked`/`checked_at` and resets the quantity ([D-200]); `last_bought_at` persists ([§6.6]). Its sort menu offers last purchased (default), A→Z and by category, kept in `meta.history_sort` ([D-121]).

### 9.1 Two views: shop (tiles) and list (rows)

**Live preview ([D-117], [D-228]).** `/dev/gallery` renders every state of a list's contents with the production `ShopItems`/`ListItems` over fixtures.

**Two views, separate jobs.** The **shop view is only for checking off**; the **list view is only for building and editing**. Both are client-side presentations over the same Dexie `items`.
- **View choice:** `meta.list_view`, device-local and last-used; its only writer is the „Einkaufen“/„Bearbeiten“ switch in the app bar ([D-101], [D-276]). A list's sub-screens (previous items, category editor, text import) show no switch ([D-323]).
- **Item order ([D-115]):** both views share one order, **by category** (`sort_order` → name, Others last; the default) or **A→Z**, chosen from the app bar's sort menu and kept device-local in `meta.list_row_sort`, never synced. Checked items are newest-checked first.

**Item visuals.** A category's emoji and colour show on its header, on a list row's chip in A→Z, and on each list-density row ([D-37], [D-313]); emoji are OpenMoji artwork drawn through `CategoryIcon` ([D-180], [D-181]). The shop view shows an item's **product photo** (`image_url`, [§9.2]) or its name; the list view shows no photos. **An item reads in three tiers**, name over quantity over note, with no quantity under 13px and no note under 12px ([D-275]).

**Shop view ([D-83]).**
- **Tiles** under category headers in category order, or one flat locale-collated grid in A→Z. Two columns on phones, more as the viewport grows ([D-49]).
- A device-local **density**, `meta.ui_density` (comfortable, compact or list, [D-313]), set in the sort menu ([D-271]); it changes neither colours nor check-off targets.
- **A tile never drops a field**, only truncates it.
- **The info door shows exactly while the tile hides something** the read-only details sheet would show: a cut name or note, a barcode, or (as a list-density row) a photo. The sheet shows image, barcode, quantity, category, note and attribution.
- **A tile has one gesture, the tap**, which checks it off. Checked items move to a collapsible **„Erledigt“** section at the bottom (open by default), newest first; a tap there restores one. Each check raises the undo toast.
- **No adding or editing here**: „Liste bearbeiten“ opens the list view with the add field focused ([D-213]).

**List view.**
- The **active (unchecked)** items in the shared order, collated with `Intl.Collator(locale, { sensitivity: "base", numeric: true })`.
- This is the **only** place items are added and edited, and it has **no check-off controls**.
- **Quantity** is free text, edited inline (Enter or a tap elsewhere saves, Esc drops) or in the item sheet ([D-20], [D-268]).
- **The detail sheet** (rename, aisle, note, remove) opens from the row's name or its category chip ([D-134]). **Removal** is a tombstone with an undo toast, from the sheet ([D-119]) or by swiping the row to the left ([D-289]).
- The previous-items door below the rows is always shown and is the only route to that screen.

**Empty states.** With every item checked, the list view shows an all-done line above the previous-items door. With no items, it points at the add field. (No lists: [§9.3].)

**Undo toast.** One **ephemeral**, self-dismissing toast (not persisted, not synced, apart from the sync chip, [§12.1]) that reverses the **last** check-off, restore, remove or re-add in one tap ([D-213]). A failure of something the user asked for takes the same slot with a red icon ([D-332]).
- Undoing a remove clears the tombstone ([§8.2]). A remove of a remembered purchase says it stays under „Frühere Artikel“ ([D-18]).
- Undoing a re-add from history tombstones the row, so it returns to „Frühere Artikel“ with its purchase date intact (`checked_at`/`last_bought_at` are server-stamped, [D-26]). Only undoing a restore of this trip's check-off re-checks.

**Dedup-aware add.** A typed or selected name (or scanned `barcode`, [§9.2]) that matches an **existing item** on this list by normalized name ([§9]) goes to it instead of duplicating, whether active, checked, or removed but remembered as bought ([§6.10], [D-18]). An active match scrolls into view and the field keeps focus; a checked or remembered one **re-activates**, with an undo toast. Races past this local check are absorbed by the server's **`merged` create** ([§8.3], [D-29]): the first-committed row survives, quantity included; a merge into a checked row re-activates it; a discarded typed quantity raises the passive toast ([§8.4]).

### 9.2 Adding by barcode scan

An optional scanner adds a product with its picture as an ordinary `items` row ([§6.6], [D-21]). The browser never contacts the product databases.

1. **Scan, on the device.** `zxing-wasm` behind the `BarcodeDetector` API on every browser. A first scan while offline falls back to typing ([D-95]).
2. **Resolve.**
   - **Device cache:** the never-synced Dexie `scanned_products` store; hits 30 days, misses 24 hours; concurrent scans of one barcode share one request.
   - **Server:** the authenticated `GET /api/barcode/{ean}?lang=de|en` (8 to 14 digits, rate-limited per IP, [§10]) reads the persistent `barcode_cache` (hits 30 days; misses, and a hit whose photo has not arrived, 5 minutes), then **Open Food Facts**, then the sister database OFF names (**Open Beauty Facts**, **Open Pet Food Facts** or **Open Products Facts**). Upstream calls time out after five seconds. It returns the name in the requested language where the database has it, else the main language, a **same-origin photo path**, and a category slug mapped from the most specific category tag. The server downloads the photo beside the lookup: it waits three seconds for it, then answers without it while the download goes on for up to a minute. A photo that fails for a reason that can pass is retried ([§13]); one that cannot is not asked for again until the product's refresh. A photo that arrives late goes to every item with that barcode and no photo ([D-21], [D-266]).
   - **Miss everywhere:** "Product not found. Type the name instead." and the normal typeahead; a miss never blocks adding. With the scanner on, each boot checks the four databases can be reached and logs a warning when not ([D-260]).
3. **Create** the item with `name`, `name_de`/`name_en` (where the database has them), `category_key` and `barcode`; the server stamps `image_url` from the barcode ([D-266]). `image_url` is `/api/barcode/photo/{token}` on our own origin (SW-cached; the category emoji on a miss), stored once on the server and swept by [§13]'s barcode photo sweep once no item references it. Dedup as in [§9.1]; a name match typed without a barcode takes the scanned one, and its photo.

- **Operator switch ([D-218]).** `SHOPPINGLIST_SCANNER=off` removes the lookup route, the scan button (the shell carries `shoppinglist-scanner=off`) and camera permission (`camera=()`). The photo route stays.
- **Attribution.** Product images are CC BY-SA, so a "Photo: Open Food Facts contributors" credit sits near the image.
- **iOS installed-PWA camera** is on the [§5.7] manual checklist.

### 9.3 Lists home & switching

The app root is the **„Meine Listen“ home**: the user's `memberships` as cards, each by its list's `name` ([§6.4]). A card opens the list in the current `meta.list_view` ([§9.1]); the in-list title carries a **▾ quick-switch** of lists.

**Back ([D-230]).** The system back and the in-app ‹ agree everywhere: back closes the top sheet, dialog, menu or arrange mode first, a ‹ never pushes a second copy, and switching lists replaces the current one, so back leads home.

**Per-list card**, computed client-side via `liveQuery`, no new field:
- the list's `name`;
- a **remaining count**: „‹open› offen“ (`!checked && !deleted_at`), „alles erledigt ✓“ when nothing is open, „leer“ with no items; no purchased totals;
- a **member count** when the roster cache ([§7.4]) shows more than one member;
- an **unsynced dot** with the list's pending count from `pending_ops` ([§8.2]).

**Ordering**, device-local in `meta.list_sort`, never synced ([D-115]):
- **Recent activity** (default): by each list's newest item or category `updated` (the digest's `max_updated`, [§8.5]);
- **Alphabetical**: `name` via `Intl.Collator(locale, …)`;
- **Custom**: an id array in `meta.list_order`, set in an arrange mode from the sort menu ([D-90]); a new or joined list goes to the top. **Cards never drag**, so a tap always opens one.

**Creating and joining** (online-only):
- **„Neue Liste“** → name prompt → `POST /api/lists` ([§7.5]) → opens the new list; disabled offline.
- **Joining** is a tapped invite link ([§7.6]), or a pasted link or token under „Mit Einladung beitreten“, into preview → join.

**Importing ([D-254])** is a screen, `/import`, reached from „Liste importieren“, from two lines or more pasted into a list's add field (`/list/[id]/import`, [D-271]), and as the share target (`/import?text=…&title=…`). It takes a backup file ([§7.5]) or a list as text (this app's share format, Mealie's and Tandoor's copies, or any plain list); other structured text is named, not itemised. Nothing is written before a review of the items under the aisles they will land in. A new list, named after the text's title line, is created through the backup import route (online-only); an existing list gets the rows through the outbox (offline too), a checked or remembered name coming back as a re-add ([D-200]).

**Cold start.** A new account has no lists ([§7.5]): the home offers „Neue Liste“, „Mit Einladung beitreten“ and „Liste importieren“. It does so only once memberships have been pulled (`meta.memberships_synced_at`, stamped right after the membership upsert, wiped on sign-out); before that a zero-list home shows „Deine Listen werden geladen …“ with no actions ([D-182]).

**A list's ⋮**, inside the list and on its card, offers ([D-270], [D-271]): edit categories ([§6.7], inside the list only), share ([§7.1]), rename (any member, [D-08]), duplicate ([§7.5]), export a backup ([D-72]), leave ([§7.2]). Rename, duplicate and leave are server calls, greyed out offline ([§11]).

---
## 10. Security summary

**Rate limits** are per IP: an IPv4 address (IPv4-mapped included), an IPv6 address by its /64, since one line is handed a whole /64; PocketBase's own catch-all counts every address apart. **`backend/internal/security/ratelimit.go` is the single table** of budgets ([D-307]), the one below: every custom route has a budget there or is named there as left to PocketBase's catch-all, and a test fails a route with neither. The demo build adds its own `demo/start` budget ([D-234]).

<!-- rate limits (rendered from backend/internal/security/ratelimit.go by its test) -->
| Budget | Calls per IP | Routes |
|---|---|---|
| `sync_push` | 300 per 5 minutes | `POST /api/sync/push`, the only sync write path |
| `passkey_begin` | 30 per minute | `POST /api/passkey/register/begin` and `POST /api/passkey/login/begin`, one budget for both |
| `passkey_finish` | 30 per minute | `POST /api/passkey/register/finish` and `POST /api/passkey/login/finish` |
| `invite_preview` | 30 per minute | `POST /api/invites/preview`, unauthenticated |
| `invite_join` | 30 per minute | `POST /api/invites/join` |
| `invite_mint` | 30 per minute | `POST /api/lists/{listId}/invite`, link rotation at a human pace |
| `barcode_lookup` | 30 per minute | `GET /api/barcode/{ean}`, the Open Food Facts proxy |
| `barcode_photo` | 300 per minute | `GET /api/barcode/photo/{token}`, unauthenticated (an `<img>` carries no token); one request per shop tile |
| `list_create` | 30 per 5 minutes | `POST /api/lists`: one row plus a category copy per call |
| `list_import` | 10 per 5 minutes | `POST /api/lists/import`: up to 2000 items per call, the amplifier |
| `list_clone` | 10 per 5 minutes | `POST /api/lists/{listId}/clone`: a whole list, the other amplifier |
| `clear_history` | 30 per 5 minutes | `POST /api/lists/{listId}/clear-history`: a bulk update across a list |
| `missing_categories` | 30 per 5 minutes | `POST /api/lists/{listId}/categories/missing`: at most one row per template per call |
| `invite_revoke` | 30 per minute | `POST /api/lists/{listId}/invite/revoke`, mint's twin |
| `account_write` | 10 per minute | `POST /api/account/delete`, `POST /api/account/link`, `POST /api/account/unlink` and `POST /api/account/rotate-token-key`, one budget |
| `cred_rename` | 30 per minute | `POST /api/credentials/{id}/rename`, a passkey's label ([§5.4]) |
| `client_error` | 10 per minute | `POST /api/client-errors` |
<!-- rate limits end -->

Left to PocketBase's catch-all:

<!-- unlimited routes (rendered from backend/internal/security/ratelimit.go by its test) -->
- `GET /api/sync/digest`: polled every ~60s by every device ([§8.5]): a per-IP budget would cut off a household whose phones share a NAT.
- `GET /api/sync/snapshot/{listId}`: the digest's repair read ([§8.5]): it runs only for a diverged list, but for every list at once after an eviction ([§8.8]), a repair a budget would stall.
- `GET /api/lists/{listId}/members`: a cheap read ([§7.4]).
- `GET /api/seed-version`: a constant.
- `GET /api/auth/methods`: one cached lookup ([§5.9]).
<!-- unlimited routes end -->

- **Size caps** bound how much, where rate limits bound how fast: a list holds at most 5,000 items rows unless `SHOPPINGLIST_MAX_ITEMS_PER_LIST` moves it, and 200 categories (`listcap.MaxCategories`), tombstones included, past which a push create is denied `list_full` ([§8.3], [D-217]); an import brings at most the lower of the cap and the backup cap. An account is on at most 25 lists (`SHOPPINGLIST_MAX_LISTS_PER_ACCOUNT`); past that, create, import and clone answer 409 `list_limit`, and joining is never refused ([D-219]).
- **Request bodies:** every app route is registered on one group (`security.AppRoutes`) with a 64 KiB body limit, so a longer body is a 413 before a handler reads it. Push and import alone opt back into PocketBase's 32 MiB (`security.LargeBody`), which their op, row and field caps need; PocketBase's own routes keep their limits.
- **Open signup** is spammable; the limits and the orphan sweep ([§13]) are the mitigation. `SHOPPINGLIST_SIGNUP=closed` closes it, `invite` admits only holders of a list's invite link ([D-61], [D-241]).
- **Invite tokens:** their lifecycle and storage are [§7.1]'s, their randomness [§10.1]'s; a token is an invitation, not a credential ([§7.6]).
- **`Referrer-Policy: no-referrer`** app-wide; no URL carrying a token reaches an error report.
- **Global reference data is not client-writable:** clients read `category_templates` and `item_dictionary` ([§6.7], [§6.9]); writes are superuser-only. All item and category writes go through `sync/push`, which enforces membership; a list's name is the one shared field written directly, under the membership rule and the lists update guard ([D-08]).
- **Sessions and their revocation:** [§5.6].
- **Account self-update is hook-allowlisted** to `nickname` and the suggestion-suppression preference ([§11], [D-32]); deletion is its own route ([§4.5]).
- **`img-src 'self' data:`**: no third-party image host is reachable; product photos are stored and served by the backend ([D-21]). With `items.image_url` server-stamped from the barcode ([D-266]), this is the second wall against a member pointing other members' browsers at a host of their choosing.
- **`GET /api/barcode/photo/{token}` is the one unauthenticated route that serves stored user data** (an `<img src>` carries no bearer token, and the auth token is not a cookie, [§5.6]). The token is **128 `crypto/rand` bits**, so the route is not enumerable and cannot answer “has this household scanned *X*?”; it is rate-limited. This holds only while the `photo` field is **`Protected`** (else PocketBase's `/api/files/…` serves every photo, outside token and limiter) and the stored file is **named after the token, not the barcode** (PocketBase echoes the filename in `Content-Disposition`).
- **RP-ID and a secure context**, both checked at startup ([§5.7]); a browser outside a secure context gets one screen in place of the app ([§12]).
- **API rules and route checks enforce the whole access model** ([§11]), tested with explicit “unauthorised access is denied” cases ([§14]).

### 10.1 Cryptography in use

Every cryptographic primitive the app relies on, who owns it and what it protects ([D-203]). No crypto is implemented here ([§5.1]); the code only picks primitives from the Go standard library, PocketBase, go-webauthn and the browser.

| What | Primitive | Owner | Protects |
|---|---|---|---|
| Passkey ceremonies ([§5.4]) | WebAuthn assertions: the algorithms go-webauthn accepts by default (ES256, RS256, EdDSA among them), no attestation requested, user verification required | go-webauthn | sign-in; the server stores only public keys |
| Ceremony challenge ([§5.5]) | 32 random bytes from go-webauthn, single-use, ~5 min | go-webauthn | replay of a ceremony |
| Auth tokens ([§5.6]) | JWT, HS256, keyed by the account's `tokenKey` + the collection's secret | PocketBase | every API call; rotating `tokenKey` revokes all of an account's tokens |
| Invite tokens ([§7.1]) | 32 bytes `crypto/rand`, base64url (`randid.Token`); looked up by its SHA-256 hex | `internal/invites` | joining a list; a revoked or expired link opens nothing |
| Setup link ([D-241]) | 32 bytes `crypto/rand`, base64url, as invite tokens; SHA-256 in memory only, compared with `crypto/subtle` | `internal/signup` | the first account of an invite-only instance |
| Server-minted ids, photo tokens, handles | `crypto/rand` (`internal/randid`: 128 bits for ids and photo tokens, 64 for handles) | `internal/randid` | unguessable list ids and photo URLs ([§10]); PocketBase's own id generator is `math/rand` and never used where guessing matters |
| Client-minted ids (items, categories, op ids, `browser_id`) | `crypto.randomUUID()` (122 random bits) | browser | collisions and guessable ids |
| OIDC sign-in ([§5.9]) | authorization code with PKCE (S256) and `state`; user data from the userinfo endpoint over TLS, so the id_token's signature is never relied on | PocketBase | the provider round-trip |
| Superuser password | bcrypt | PocketBase | the dashboard |
| Outbound HTTPS (Open Food Facts, the OIDC provider) | Go `crypto/tls` defaults, the image's CA bundle | Go | lookups and the token exchange |
| Inbound HTTPS | none in the binary: the operator's reverse proxy or tunnel terminates TLS | operator | everything on the wire |

**Not security, but hashes all the same:** the sync digest ([§8.5]) is SHA-256 over `{id}:{updated}` pairs, and a product photo's `photo_hash` is SHA-256 of its bytes. Both only detect change; a collision costs a missed refresh, not access.

**Not encrypted:** the SQLite database and its backups are plain files on the operator's disk, protected by the filesystem; an operator who wants more encrypts the volume or the backup destination.

---

## 11. API rules (PocketBase collection rules)

Rules live in checked-in migrations ([§14]).

| Collection | list/view | create | update | delete |
|---|---|---|---|---|
| `accounts` | self only (`id = @request.auth.id`; `emailVisibility` false) | none (passkey routes, and the [§5.9] OIDC hook, which pre-creates at system level [D-76]) | self: the update hook refuses a changed `handle` and caps `nickname`, PocketBase's own form refuses the auth fields (`email`, `verified`, `tokenKey`; email is never set: [§4.4], [D-25]) [D-32] | none (account-deletion route only, [§4.5]) |
| `credentials` | own only | none (passkey routes only) | **deny** (no rule, migration 1778000003; `friendly_name` via `POST /api/credentials/{id}/rename`, [§5.4]) | own, guarded by the **last-credential delete-hook** ([§5.4]): refuses removing the last credential of an account with no OIDC login; account-deletion route exempt via a context-scoped bypass ([D-32]) |
| `lists` | requester has a membership on the list | **deny** (route [§7.5]) | requester has a membership on the list; `name` only in effect (its only own column), bounded and kept non-empty by the lists update guard [D-08] | **deny** (cascade only) |
| `memberships` | **own rows only** (roster via route [§7.4]) | **deny** (join route) | **deny** ([D-08]) | **own only** (= leave, fires cascade [§7.3]) |
| `items` | requester has a membership on `item.list` | **deny** | **deny** | **deny** (all writes via sync push) |
| `list_categories` | requester has a membership on the list | **deny** | **deny** | **deny** (all writes via sync push) |
| `category_templates` | **authenticated** (read-only reference) | none (superuser only) | none | none |
| `item_dictionary` | **authenticated** (read-only reference) | none (superuser only) | none | none |
| `invites` | member of the list | **deny** (mint route only, [D-31]; migration 1778000007) | **deny** (mint/revoke routes only, [D-31]) | deny |
| `_externalAuths` (PocketBase's OIDC-login rows) | own only (PocketBase's stock rule) | none (PocketBase's exchange) | none | **deny** over the record API: PocketBase's owner rule cannot be changed on a system collection, so `account`'s request hook refuses it; removal is `POST /api/account/unlink` only ([D-76]) |
| `oidc_identities` | no rules (server only; the label `GET /api/auth/methods` reports, [D-76]) | none | none | none |
| `barcode_cache` | no rules (server only; read only by the `/api/barcode` routes, [§9.2], [§10]) | none | none | none |
| `merge_log` | no rules (server only; the push route's record of merged create ids, [D-108]) | none | none | none |

Membership filters (e.g. on `items`) are a cross-collection reference: “the requester's account appears among `memberships` rows for this list”. **Both conditions must bind to the same membership row**; PB's single-join semantics for a repeated `@collection.memberships.*` reference give this, and the [§14] integration tests pin it against the pinned version. Leave is a hard delete, so no rule needs tombstone awareness.

Realtime SSE subscriptions obey the same list/view rules: a member who leaves stops receiving events at once.

---

## 12. Frontend

- **SvelteKit** with `adapter-static` → static SPA in `pb_public`.
- **A secure context or nothing** ([D-335]): while `window.isSecureContext` is false, the root layout shows `InsecureView` in place of the app, saying to open the HTTPS address or `http://localhost:<port>` on the machine it runs on, and starts nothing but the language ([§5.7]).
- **Dexie** stores: `lists`, `items`, `list_categories` ([§6.7]), `server_items` + `server_list_categories` (the [§8.2] shadow of the last server state, [D-40]), `category_templates` + `item_dictionary` (read-only mirror), `memberships` (own), `roster` (per-list member cache), `scanned_products` (device-local barcode→product cache, never synced, [§9.2]), `pending_ops`, and `meta`. `meta` holds `last_synced_at`; `sync_health` (what the leader last saw of the server, [§12.1], [D-296]); `memberships_synced_at` (this account's memberships have arrived at least once, [D-182]); the mirror's `seed_version` ([§6.12]); `locale`; `list_view`; `ui_density`; `install_prompt_dismissed`; the device-local, unsynced sort choices `list_row_sort` ([§9.1] [D-115]), `history_sort`, `list_sort` / `list_order`; and the mirror of the account's **suggestion suppression** with its `suppressed_pending` intents ([§6.11] [D-137]). There is no sync cursor: [§8.5] reconciles per list, by digest.
- **PocketBase JS SDK** with an IndexedDB-backed async auth store; the token is refreshed once on start (`refreshSessionToken`, not the SDK's `authRefresh()`, [D-156]).
- **`@simplewebauthn/browser`** for the ceremonies.
- **Service worker:** SvelteKit's, app-shell precache; installable PWA. Installing is offered only after sign-up ([D-231]): a banner for a signed-in user where Chromium offers installation, and the settings screen's first card in a browser tab.
- **Settings** is one column of groups in the list's look ([D-269]): app (install, browser tab only), account (nickname, the OIDC link or login), passkeys (not with passkeys off, [D-76]), general (language, theme, hidden suggestions), sign out (this device, everywhere), and deleting the account, above the about footer. Leaving a list is on the list's ⋮ menus ([D-270]).
- **Client errors reach the server log** ([D-197]): each distinct error is posted once per page session to `POST /api/client-errors` (unauthenticated, 16 KB cap, rate-limited, stores nothing, one log line); the error page offers „Neu laden“.
- **Lists home ([§9.3])** is the app root; **two views ([§9.1])**, shop and list, both fully functional offline, the choice persisted in `meta.list_view`.

**Colour [D-114].** Green lives in the primary alone, split into a fill (`--primary`) and a text colour (`--primary-text`); in the app bar it marks a state ([D-276]). Category colours share one lightness and chroma per theme and differ by hue ([D-37]). Values live in `frontend/src/app.css`; `design-tokens.test.ts` checks their contrast.

### 12.1 Sync-status chip

Sync state is a permanently visible chip left of the title in **every app bar** (one `AppBar`, [D-272]). It is the only control that clears the *expired* state, which any screen can reach ([D-130]).

- **N = count of `pending_ops`** (one per record after coalescing), scoped to the list on screen ([§8.2]); on the home and settings, the whole device's outbox ([D-130]).
- **Form** ([D-102]): one glyph in a fixed 26×26 box, so nothing around it moves: a cloud when synced, **the count itself** whenever N>0 (amber, capped at 99+, `aria-hidden`), a grey `cloud-off` when offline with nothing pending, a grey **clock** when stale or broken, a `key-round` on solid `--danger` when expired. No two states share a glyph, and the one actionable state is the app bar's only **filled** chip.
- **Last sync time** comes from `meta.last_synced_at`, stamped by the **leader tab** ([§8.7]) after each successful drain → digest → repair cycle ([§8.2], [§8.5]), and is shown **only offline**.
- **States** (Dexie `liveQuery`, the `online` store, `authState`): synced → "All changes synced", **only while true**; stale (three exchanges in a row have failed with nothing pending) → "No answer from the server · last ‹when›" ([D-296]); broken (three in a row failed in the app itself) → the same clock, or the count while changes wait, "Sync isn't working"; pending → "‹count› changes not synced yet"; offline → "Offline · ‹count› not synced", "last synced ‹when›" for a screen reader; expired (online, session invalid) → the chip is the one-tap [§5.8] re-auth button, whose **failures show as a toast**, a dismissed ceremony staying silent ([D-130]). **Offline wins over an expired token**, since re-auth needs connectivity. The chip complements the [§8.4] notices, never blocks use and never auto-hides.
- **The line under the list's name** says what the chip cannot ([D-296]): the members while the sync is fine or a change is on its way, otherwise one short status in their place, amber when something of the user's is not getting out or the app itself fails, grey otherwise:
  - after three failed exchanges in a row, their reason: no answer, a 5xx, a 429, or the app's own error (no HTTP status, as a request without an answer carries 0, or a 4xx other than 401, 408 and 429, a refusal that repeats on every try), which shows „Sync-Fehler · neu laden“ pending or not;
  - with nothing pending after three failures in a row, how old the last good exchange is („Stand: ‹when›“), since what others change is not arriving;
  - „Wartet auf anderen Tab“ or „App hängt · neu laden“ when a change has waited 20 s and no exchange has started or ended for 20 s, none being under way (never in a page's first 20 s; one under way for a minute counts as frozen, since a cycle's push and digest time out within 25 s);
  - offline, and since when.

  A tap on the members opens „Teilen & Mitglieder“ ([§7.1]), the name keeping the quick switcher; the two tap boxes meet where the rows meet, so the bar stays 56px. A tap on a status opens a sheet that explains it and offers the one action that helps: send now (a cycle in the leader, over a `BroadcastChannel`), sync now, reload (stuck, broken); none for another tab ([D-288]). Every tab reads it from `meta.sync_health`, which the leader writes at the start and the end of every exchange ([§8.7]): when one last worked, started and ended, the failures in a row and the last one's reason.
- **Accessibility.** Each state's full sentence is `.sr-only` inside the chip and its `title`: it is the accessible name and the announcement of a **permanent** `role="status"` wrapper, so the move into *expired* is announced. **Every `[data-slot="button"]` control has a 44px effective target**; a smaller painted box gets it from an invisible `::after` hit inset, as the chip does, pinned by the target-size sweep [D-56].
- **Contrast:** the pending glyph, the expired chip and the aisle-count tint clear WCAG AA (≥4.5) in both themes, pinned by `design-tokens.test.ts`, which recomputes every recipe from `app.css` ([D-102]).

### 12.2 Localization (i18n)

- **The entire app is localized** ([D-22]). Three tiers: (1) **all UI chrome**, including the chip ([§12.1]) and conflict notices ([§8.4]), is a translated message, never a literal; (2) **app-seeded vocab**, `category_templates.name_i18n` / `item_dictionary.names_i18n`, rendered in the current locale, falling back to `en`, then the slug; (3) **user-entered text** (item and list names) is never translated.
- **de + en, additive.** Compile-time i18n with **Paraglide** (`@inlang/paraglide-js`, pinned to 2.x, [§2]), so no catalog is fetched at runtime and it works from the app-shell cache. A new language is a UI locale file, seed keys, an entry in `project.inlang/settings.json` `locales` (Paraglide generates the `Locale` type from it) and a `browserLocale()` prefix (`#lib/i18n`).
- **Locale selection ([D-68], [D-223]):** (1) the explicit choice from the `LocaleToggle` in settings **and on the auth and join screens**, persisted in `meta.locale` and never overridden; (2) the browser's language, when it is a shipped locale (`de*`/`en*` on the lowercased tag); (3) `en`. There is no instance default.
- **A switch changes the strings in place, in every open tab** [D-291]: nothing is remounted and nothing a screen holds is lost. Lint refuses a message resolved once into a constant of a component script.
- **Locale stability:** items reference categories by **stable row id** and store free-text names, and a category's default label comes from its seed `slug` ([§6.7]), so switching language changes labels only, never item↔category mapping or history.
- **Interpolated and plural strings are messages** with named placeholders, **never concatenation**; counts use plural rules.
- **Formatting** goes through `Intl` (`Intl.RelativeTimeFormat` for relative times); no hand-rolled formatters.
- **RTL-ready:** logical CSS properties, `dir="auto"` on user-text fields. No RTL locale ships.

---

## 13. Background jobs (PB cron)

Scheduled in `internal/jobs`, each sweep written in the package that owns its table; what each job does, as operators read it, is [operating.md's table](../operating.md#cron-jobs), rendered from the same registry. The window is the age a sweep deletes past, or for the retry how long after a lookup it keeps trying.

<!-- cron jobs (rendered from backend/internal/jobs/jobs.go by its test) -->
| Job | Schedule | Window | Sweep |
|---|---|---|---|
| `tombstone_gc` | daily, 03:00 UTC | 180 days | `sync.SweepTombstones` |
| `invite_sweep` | daily, 03:00 UTC | 30 days | `invites.Sweep` |
| `orphan_sweep` | daily, 03:00 UTC | 60 days | `account.SweepOrphans` |
| `barcode_photo_sweep` | daily, 03:00 UTC | 180 days | `barcode.SweepPhotos` |
| `barcode_photo_retry` | every 15 minutes | 2 days | `barcode.RetryPhotos` |
| `merge_log_sweep` | daily, 03:00 UTC | 180 days | `sync.SweepMergeLog` |
<!-- cron jobs end -->

- **`tombstone_gc`** hard-deletes tombstoned `items` and `list_categories` rows, **except `items` carrying a `last_bought_at`** (previous items, [§6.10] [D-18], kept indefinitely) **and `list_categories` carrying a `slug`** (a removed template aisle, which the missing-categories route must not add again, [D-251]). No cursor depends on the window ([§8.5]), so it only has to cover a realistic offline gap.
- **`invite_sweep`** deletes invites past expiry, and revoked ones by their `updated`, which the revocation stamps.
- **`orphan_sweep`** deletes accounts with **zero memberships**, older than the window and with no credential `last_used_at` within it, each through the [§4.5] teardown (`account.DeleteAccount`).
- **`barcode_photo_sweep`** deletes `barcode_cache` rows by `fetched_at` *whose photo no item still references*, tombstones included (equality against the exact issued URL, [D-21], [D-266]). Bounds `pb_data`. Deletes go through the record API one row at a time, so the image file goes with the row.
- **`barcode_photo_retry`** downloads again the photos that failed for a reason that can pass, ten per run, one at a time; a photo that arrives goes to the items with that barcode and none ([D-21]).
- **`merge_log_sweep`** deletes `merge_log` rows ([D-108]) by `merged_at`; a list's rows also go with the list ([§7.3]).
- **The demo sweep**, every 10 minutes, **demo build only** ([D-234], in `internal/demo`): deletes accounts past the demo lifetime, through the [§4.5] teardown.

---

## 14. Deployment, CI & testing

### Deployment
- **Build:** PocketBase is imported in `main.go`, which registers routes, hooks and crons; the SvelteKit SPA is built into `pb_public` and **embedded at compile time** into a single binary ([D-64]; `-tags no_ui` builds without it, for tests and the dev loop).
- **Demo build ([D-234]):** `-tags demo` adds a one-button sign-in to a throwaway account deleted 24 hours after creation (`POST /api/demo/start`), with the client half behind the `#demo` import. **Neither the normal binary nor the normal bundle contains any of it** (`deps_arch_test.go`, `task build-spa`). Each release publishes it as the `:demo` image ([D-235]); [`demo.md`](demo.md) says how to run a public one.
- **Artifacts:** a **multi-arch Docker image** (incl. arm64) and a **plain binary zip** (UI included, no Docker needed), semver-tagged, with the SBOM attached ([D-203]).
- **License:** AGPL-3.0. Settings links `SHOPPINGLIST_SOURCE_URL` (default: this repository), which an operator of a modified version points at theirs ([D-211]).
- **Backups:** PB scheduled backups, on from the first start, a failure on the container log too ([D-334]); the schedule, how many are kept and how an operator changes them (incl. S3-compatible) or copies the data directory: [operating.md](../operating.md#backups). A start about to apply a migration or a new seed first zips `pb_data` to `pb_data/backups/pb_backup_pre_upgrade_*.zip`, before opening the database, and prunes the older ones ([deploy-reference.md](../deploy-reference.md#upgrades)); it cannot be skipped ([D-183], [D-223]).
- The **idempotent boot seeder** ([§6.12]) fills the reference data from the embedded seed files.
- **Settings are env vars** ([D-65]), each in [`deploy-reference.md`](../deploy-reference.md#environment-variables); `SHOPPINGLIST_APP_URL` and `_TRUSTED_PROXY_HEADER`, when set, win over the admin UI at every boot. Every setting but `SQLITE_PRAGMAS` is `SHOPPINGLIST_`-prefixed; each is declared once in `backend/internal/settings/settings.go`, which renders the reference's tables ([D-337]); any non-empty `EINKAUFSLISTE_` variable refuses the boot, naming each ([D-222]), and so does a non-empty `SHOPPINGLIST_` (or `SQLITE_PRAGMA…`) name that is no setting, a removed one included ([D-336]). The compose file hands `.env` over whole ([D-263]). Values only the client acts on (item cap, scanner switch, source link, version) are stamped into the shell document as `shoppinglist-*` meta tags (`internal/ui`).

### CI (Woodpecker)
**Tests run against real PocketBase (in-process or the built binary), not mocks**: the security lives in rules and route checks. How to run each layer, the gate and its harnesses: [AGENTS.md](../../AGENTS.md) and [impl-notes.md](impl-notes.md).

**What the layers guarantee:**
1. **Unit (Vitest, Go):** the client sync engine (coalescing, base capture, result application, conflict state, `gone`), and **every branch of the server merge** ([§8.3]): apply / no-op / conflict / `merged` / deleted_conflict / convergent-delete `noop` / gone / denied / Others protection, plus `checked_at` stamping (a concurrent double check-off converges with **zero** conflicts).
2. **Integration (real PocketBase, fresh DB, every migration: Go tests in-process; the vitest `integration` project against the real binary):** the access model, with **explicit “unauthorised access is denied” cases**: A cannot read or write B's lists; direct writes to `items`/`list_categories`/`lists` are denied even for members; a member reads only their own membership rows and renames only lists they are on; the roster requires membership; revoked/expired invites fail; preview cannot mutate; passkey-finish and invite routes are rate-limited; the membership filters bind one row ([§11]); last-one-out (incl. two concurrent leaves) leaves zero orphans; account deletion cascades solo lists and leaves shared lists and their items intact ([§4.5]); the last credential of an account without OIDC cannot be deleted, but the account-deletion route removes all; the self-update allowlist ([§11]); reference data readable but not writable by a non-member; list creation is atomic with the membership and the seed categories ([§7.5]). Two Dexie clients against the binary pin the [§8] outcomes ([§8.5] hydration and repair, conflicts, `merged`, `gone`).
3. **Component (Vitest + `@testing-library/svelte`, happy-dom):** among them the lists-home card counts and its three ordering modes ([§9.3]).
4. **E2E (Playwright, Chromium):** passkeys via the CDP virtual authenticator; offline mutate → reconnect → the server **and a second client** converge; a same-field conflict shows first-committed-wins and the passive notice; service worker and install. Separate harnesses: arch dead controls ([D-124]), OIDC against Dex ([D-154]), the tile audit ([D-166]), in Firefox too ([D-301]), the demo ([D-234]).
5. **Manual:** the passkey ceremony inside the installed PWA on a physical iPhone and an Android device ([§5.7]).

**Where they run.** **CI runs every layer and harness on every push**, in the devcontainer's `toolchain` image ([D-203]); locally, `scripts/gate.sh` runs the fast layers a change can reach and a browser harness only when named ([D-177]). In `.woodpecker/`, `frontend` and `go` run in parallel and `e2e` waits on both; `security` (govulncheck, osv-scanner) runs weekly and on a push that changes a dependency. A `v*` tag re-runs the checks on the tag event, and `release` publishes only after that event's own `e2e` passed ([D-66]).

**Standing rules:**
- **Schema and rules are checked-in Go migrations**, the source of truth, never set in the admin UI.
- **Every dependency is pinned to an exact version** when introduced, in each `package.json` as in the lockfiles (Renovate's `rangeStrategy: 'pin'`). The PocketBase version is pinned in `go.mod`, identical in CI and prod.
- **Every custom route gets a “denied” test** beside its happy-path test.

---

## 15. Deferred / out of scope for v1

What v1 leaves out, and why: [`decisions.md`](decisions.md#deferred-and-out-of-scope-for-v1).

---

## 16. Known risks & mitigations

| Risk | Mitigation |
|---|---|
| PocketBase pre-1.0, breaking minors | Pin exact version; Renovate; SQLite portability = low exit cost |
| PB token-minting API shifts | Token handoff isolated; tests run against the pinned version |
| No bad-actor eviction (no-owner model) | Accepted tradeoff for known-each-other groups ([D-06]) |
| Passkeys flaky in installed PWA (esp. iOS) | Manual ceremony test **inside the installed app** on-device ([§14]) |
| Device-bound passkey → lost account | Multi-passkey backup nudge; the OIDC login where offered |
| iOS IndexedDB eviction | `storage.persist()`; server is source of truth; passkey re-auth re-pulls |
| Open anonymous signup on public instances | Rate limits + orphan sweep; per-list categories leave no shared state to vandalise; `SHOPPINGLIST_SIGNUP=closed` or `invite` ([D-241]) |
| Un-drained outbox lost with evicted storage | Accepted edge; window minimised by sync-on-focus |
| Barcode lookup depends on Open Food Facts | Online-only enrichment with fallback (device cache → `barcode_cache` → OFF → type it); the server proxy hides client IPs ([D-21]); `SHOPPINGLIST_SCANNER=off` removes it ([D-218]) |

---

## 17. Resolved decisions

Every decision, with its reason and what it rejected, is in [`decisions.md`](decisions.md#decision-log), cited inline as `[D-nn]`.

---

## 18. Implementation plan

The standing rules it set are in [§14].

<!-- citation links (generated by scripts/decisions-index.mjs) -->

[§2]: #2-locked-technology-stack
[§4.3]: #4-3-multiple-passkeys-per-account
[§4.4]: #4-4-no-email-login-d-25-d-76
[§4.5]: #4-5-account-deletion-self-service
[§5]: #5-authentication-passkey-webauthn
[§5.1]: #5-1-division-of-responsibility-we-write-zero-crypto
[§5.4]: #5-4-the-four-endpoints
[§5.5]: #5-5-session-data-storage
[§5.6]: #5-6-tokens-storage-revocation
[§5.7]: #5-7-rp-id-self-hosting-config
[§5.8]: #5-8-offline-session-policy
[§5.9]: #5-9-oidc-login-opt-in-alternative-d-76
[§6.1]: #6-1-accounts-auth-collection
[§6.4]: #6-4-lists
[§6.6]: #6-6-items
[§6.7]: #6-7-categories-per-list-copied-from-a-global-seed-at-creation-d-14
[§6.9]: #6-9-item_dictionary-global-app-seeded-read-only-to-clients
[§6.10]: #6-10-previous-items-checked-item-history-no-separate-collection
[§6.11]: #6-11-suggestion-suppression-account-bound-preference-d-17
[§6.12]: #6-12-seeding-of-global-reference-data-category_templates-item_dictionary
[§6.13]: #6-13-operator-content-curation-tooling-d-34
[§7]: #7-sharing-membership-model
[§7.1]: #7-1-invite-lifecycle-link-only
[§7.2]: #7-2-leave-hard-delete
[§7.3]: #7-3-last-one-out-cascade
[§7.4]: #7-4-member-roster-custom-route
[§7.5]: #7-5-list-creation-custom-route
[§7.6]: #7-6-join-preview-flows
[§8]: #8-offline-first-sync-engine
[§8.2]: #8-2-outbox-pattern-client
[§8.3]: #8-3-push-endpoint-server-side-merge
[§8.4]: #8-4-conflict-ux-client-d-11
[§8.5]: #8-5-inbound-changes
[§8.6]: #8-6-gone-handling
[§8.7]: #8-7-multi-tab-multi-context-coordination
[§8.8]: #8-8-local-storage-durability
[§9]: #9-display-sorting-item-entry-history
[§9.1]: #9-1-two-views-shop-tiles-and-list-rows
[§9.2]: #9-2-adding-by-barcode-scan
[§9.3]: #9-3-lists-home-switching
[§10]: #10-security-summary
[§10.1]: #10-1-cryptography-in-use
[§11]: #11-api-rules-pocketbase-collection-rules
[§12]: #12-frontend
[§12.1]: #12-1-sync-status-chip
[§12.2]: #12-2-localization-i18n
[§13]: #13-background-jobs-pb-cron
[§14]: #14-deployment-ci-testing
[§18]: #18-implementation-plan
[D-03]: decisions.md#D-03
[D-04]: decisions.md#D-04
[D-06]: decisions.md#D-06
[D-08]: decisions.md#D-08
[D-09]: decisions.md#D-09
[D-10]: decisions.md#D-10
[D-11]: decisions.md#D-11
[D-12]: decisions.md#D-12
[D-13]: decisions.md#D-13
[D-14]: decisions.md#D-14
[D-15]: decisions.md#D-15
[D-17]: decisions.md#D-17
[D-18]: decisions.md#D-18
[D-19]: decisions.md#D-19
[D-20]: decisions.md#D-20
[D-21]: decisions.md#D-21
[D-22]: decisions.md#D-22
[D-24]: decisions.md#D-24
[D-25]: decisions.md#D-25
[D-26]: decisions.md#D-26
[D-28]: decisions.md#D-28
[D-29]: decisions.md#D-29
[D-30]: decisions.md#D-30
[D-31]: decisions.md#D-31
[D-32]: decisions.md#D-32
[D-34]: decisions.md#D-34
[D-37]: decisions.md#D-37
[D-40]: decisions.md#D-40
[D-42]: decisions.md#D-42
[D-44]: decisions.md#D-44
[D-45]: decisions.md#D-45
[D-48]: decisions.md#D-48
[D-49]: decisions.md#D-49
[D-55]: decisions.md#D-55
[D-56]: decisions.md#D-56
[D-57]: decisions.md#D-57
[D-61]: decisions.md#D-61
[D-64]: decisions.md#D-64
[D-65]: decisions.md#D-65
[D-66]: decisions.md#D-66
[D-68]: decisions.md#D-68
[D-72]: decisions.md#D-72
[D-74]: decisions.md#D-74
[D-76]: decisions.md#D-76
[D-79]: decisions.md#D-79
[D-83]: decisions.md#D-83
[D-90]: decisions.md#D-90
[D-95]: decisions.md#D-95
[D-100]: decisions.md#D-100
[D-101]: decisions.md#D-101
[D-102]: decisions.md#D-102
[D-103]: decisions.md#D-103
[D-108]: decisions.md#D-108
[D-109]: decisions.md#D-109
[D-114]: decisions.md#D-114
[D-115]: decisions.md#D-115
[D-117]: decisions.md#D-117
[D-119]: decisions.md#D-119
[D-121]: decisions.md#D-121
[D-124]: decisions.md#D-124
[D-130]: decisions.md#D-130
[D-131]: decisions.md#D-131
[D-134]: decisions.md#D-134
[D-137]: decisions.md#D-137
[D-138]: decisions.md#D-138
[D-153]: decisions.md#D-153
[D-154]: decisions.md#D-154
[D-156]: decisions.md#D-156
[D-164]: decisions.md#D-164
[D-166]: decisions.md#D-166
[D-173]: decisions.md#D-173
[D-175]: decisions.md#D-175
[D-176]: decisions.md#D-176
[D-177]: decisions.md#D-177
[D-180]: decisions.md#D-180
[D-181]: decisions.md#D-181
[D-182]: decisions.md#D-182
[D-183]: decisions.md#D-183
[D-191]: decisions.md#D-191
[D-197]: decisions.md#D-197
[D-200]: decisions.md#D-200
[D-203]: decisions.md#D-203
[D-208]: decisions.md#D-208
[D-211]: decisions.md#D-211
[D-213]: decisions.md#D-213
[D-217]: decisions.md#D-217
[D-218]: decisions.md#D-218
[D-219]: decisions.md#D-219
[D-220]: decisions.md#D-220
[D-221]: decisions.md#D-221
[D-222]: decisions.md#D-222
[D-223]: decisions.md#D-223
[D-228]: decisions.md#D-228
[D-230]: decisions.md#D-230
[D-231]: decisions.md#D-231
[D-234]: decisions.md#D-234
[D-235]: decisions.md#D-235
[D-236]: decisions.md#D-236
[D-241]: decisions.md#D-241
[D-251]: decisions.md#D-251
[D-254]: decisions.md#D-254
[D-260]: decisions.md#D-260
[D-263]: decisions.md#D-263
[D-265]: decisions.md#D-265
[D-266]: decisions.md#D-266
[D-268]: decisions.md#D-268
[D-269]: decisions.md#D-269
[D-270]: decisions.md#D-270
[D-271]: decisions.md#D-271
[D-272]: decisions.md#D-272
[D-275]: decisions.md#D-275
[D-276]: decisions.md#D-276
[D-277]: decisions.md#D-277
[D-285]: decisions.md#D-285
[D-287]: decisions.md#D-287
[D-288]: decisions.md#D-288
[D-289]: decisions.md#D-289
[D-291]: decisions.md#D-291
[D-292]: decisions.md#D-292
[D-293]: decisions.md#D-293
[D-294]: decisions.md#D-294
[D-295]: decisions.md#D-295
[D-296]: decisions.md#D-296
[D-297]: decisions.md#D-297
[D-300]: decisions.md#D-300
[D-301]: decisions.md#D-301
[D-302]: decisions.md#D-302
[D-303]: decisions.md#D-303
[D-304]: decisions.md#D-304
[D-305]: decisions.md#D-305
[D-307]: decisions.md#D-307
[D-309]: decisions.md#D-309
[D-310]: decisions.md#D-310
[D-313]: decisions.md#D-313
[D-323]: decisions.md#D-323
[D-330]: decisions.md#D-330
[D-332]: decisions.md#D-332
[D-334]: decisions.md#D-334
[D-335]: decisions.md#D-335
[D-336]: decisions.md#D-336
[D-337]: decisions.md#D-337
