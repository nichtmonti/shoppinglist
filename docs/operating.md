# Operating shoppinglist

Running an instance day to day. To set one up, start with
[`deploying.md`](deploying.md); every setting is in the
[deployment reference](deploy-reference.md).

## Three things not to change

- **The domain.** Every passkey belongs to `SHOPPINGLIST_RP_ID`; changing it
  strands all of them, and everyone has to register again. Opening the app by
  IP or any other address fails sign-in too
  ([details](deploy-reference.md#getting-rp-id-and-rp-origin-right)).
- **The binary.** The image is this app built on PocketBase. A stock
  PocketBase binary has none of its collections, routes or rules.
- **The schema.** Collections, fields and rules ship with each release and are
  the app's permission model. Use the `/_/` dashboard for the superuser,
  backups and settings only: an edit to a collection diverges from what the
  next release expects, and loosening a rule can open data to other users.

## Backups

Everything lives in the data directory (`/pb_data` in the container): the
SQLite database `data.db` and the stored product photos in `storage/`.

**The server backs it up every night** at 03:00 UTC, into
`pb_data/backups/`, and keeps the newest seven. Those zips sit on the same
disk as the data, so copy `pb_data/backups/` to another machine too, or send
the backups to an S3-compatible bucket: `/_/` → Settings → Backups, where the
schedule and the number kept change as well (an empty schedule turns them
off). That needs the dashboard (`SHOPPINGLIST_ADMIN_UI=on`, the default). A
backup that fails says so in the log
(`docker compose logs shoppinglist | grep 'backup failed'`).

**Or copy the directory**, with the server stopped, since a live copy of
`data.db` can miss recent writes:

```sh
docker compose stop && rsync -a /path/to/pb_data/ backup-host:/backups/shoppinglist/ && docker compose start
```

For a named volume, `docker volume inspect <project>_shoppinglist_data` shows
its path on the host.

`pb_data/backups/` also holds the `pb_backup_pre_upgrade_*.zip` files the
server writes before an upgrade changes the database
([upgrades](deploy-reference.md#upgrades)). It keeps the newest three of
those; the dashboard's limit applies to the scheduled ones only.

**Restoring.** With the dashboard: `/_/` → Settings → Backups → *Restore*,
on the running server. Without it: stop the container, empty the data
directory except `backups/`, unzip the backup (or copy your copy) into it, and
start again. The image has
no shell, so for a named volume do this from a throwaway container that mounts
the same volume.

## The superuser

The superuser is PocketBase's admin account, separate from the app's accounts
and able to read and change everything. Create or reset it with
`superuser upsert` ([deploying.md, step 3](deploying.md#3-first-boot); without
Docker, `./shoppinglist superuser upsert <email> '<password>' --dir=<data dir>`).
With `SHOPPINGLIST_ADMIN_UI=off` that command is the only way in.

## Errors in the browser

The app reports an error in the browser to the server, which logs one line:

```
shoppinglist: client error message="TypeError: …" route="/list/[id]" path="/list/…" status=500 version="X.Y.Z" account="…" agent="Mozilla/5.0 (iPhone; …)" context="" stack="…"
```

Find them with `docker compose logs shoppinglist | grep 'client error'`.
Nothing else is stored. `context=` says what failed:

- `""`: a screen, while it loaded. The app shows its error page,
  "Something went wrong.".
- `render`: a screen, after it loaded. The same message takes its place.
- the download's details (`sw=…`, `pageAge=…`, `recovery=…`): a screen whose
  code failed to download. The app says "One moment…" and loads the page
  again, and after a few tries shows the error page.
- `uncaught`: an error nothing caught, with nothing on screen.
- any other word names the part of the app it happened in, such as `sync`,
  `session storage` or `liveQuery …` (the data of one view), with no error
  page. `sign-out wipe failed; …` is a sign-out that could not clear the
  device's data and deleted its local database instead.

## Cron jobs

Six jobs run on their own; there is nothing to configure, but several delete
data for good. The daily ones run at 03:00 UTC.

| Job | Schedule | What it does |
|---|---|---|
| Tombstone cleanup | daily | **Deletes** items and categories removed more than 180 days ago, except items remembered under *Previous items* and the built-in aisles a list removed |
| Invite sweep | daily | Deletes invite links that expired, or were revoked or replaced, more than 30 days ago |
| Orphan sweep | daily | **Deletes** accounts that are on no list, are older than 60 days and have used no passkey in 60 days |
| Barcode photo sweep | daily | Deletes product lookups and photos older than 180 days that no item still shows |
| Barcode photo retry | every 15 minutes | Downloads again, from the Open Food Facts photo hosts, product photos whose download failed in the last 48 hours |
| Merge-log sweep | daily | Deletes records of duplicate items merged during sync, after 180 days |

A job that fails says so in the log
(`docker compose logs shoppinglist | grep 'failed'`).

## Growing the item vocabulary

The app ships its categories and the items it knows (aisle and translation),
built into the binary and applied at boot. Items your users type are not added
to it automatically. To see which unknown names are common on your instance:

```sh
docker compose run --rm --entrypoint /shoppinglist shoppinglist dictionary-suggestions --dir=/pb_data
```

```
"kiwi"       (5 lists)  produce: 4, snacks_sweets: 1
"hummus"     (4 lists)  pantry: 2, dairy_eggs: 1, other: 1
```

It lists names seen on at least 3 lists (`--min-lists N`) and changes nothing.
To add them, in a checkout of this repository, write them to a file with
`--json`, edit it down to the entries you want, and run `go run
./cmd/appendseed -candidates candidates.json` in `backend/`. That updates the
seed files; the new entries reach an instance with the next release built from
them.