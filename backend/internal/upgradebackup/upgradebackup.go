// Package upgradebackup snapshots pb_data before a boot that is about to
// change it ([D-183]): a migration not yet applied, or a seed version the
// database has not seen. It runs in OnBootstrap before PocketBase opens the
// database or runs its system migrations, so it holds the data exactly as the
// previous release left it.
//
// The archive is the same zip as PocketBase's own backups, written to
// pb_data/backups, so the dashboard lists and restores it, and unzip does
// where the dashboard is off.
package upgradebackup

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/archive"
	"github.com/pocketbase/pocketbase/tools/hook"

	"shoppinglist/seed"
)

// Prefix names the backups this package writes, and the only ones it prunes.
// PocketBase's restore route accepts ^[a-z0-9_-]+\.zip$, which the name keeps.
const Prefix = "pb_backup_pre_upgrade_"

// Keep is how many pre-upgrade backups survive pruning; other backups are
// never touched.
const Keep = 3

// Register binds the pre-upgrade backup to app's bootstrap. withApp is true
// when this invocation (serve) also runs the app migrations and the seed, not
// just the system migrations.
func Register(app core.App, withApp bool) {
	app.OnBootstrap().Bind(&hook.Handler[*core.BootstrapEvent]{
		Id: "shoppinglist_upgrade_backup",
		Func: func(e *core.BootstrapEvent) error {
			files, seedV := migrationFiles(core.SystemMigrations), ""
			if withApp {
				files, seedV = append(files, migrationFiles(core.AppMigrations)...), seed.CurrentSeedVersion
				// Only serve knows every migration: another subcommand's list
				// lacks the app's own.
				if err := refuseNewer(e.App.DataDir(), files, slices.Max(migrationFiles(core.AppMigrations))); err != nil {
					return err
				}
			}
			path, reason, err := Run(e.App.DataDir(), files, seedV, time.Now())
			if err != nil {
				// No switch to skip it ([D-223]): an upgrade that cannot be
				// backed up waits until pb_data has room for one.
				return fmt.Errorf("pre-upgrade backup failed, so nothing was migrated (%w); "+
					"fix the cause — usually a full disk: free space in pb_data (older backups are in pb_data/backups) — and start again", err)
			}
			if path != "" {
				log.Printf("shoppinglist: %s — backed up pb_data to %s before applying it", reason, path)
			}
			return e.Next()
		},
	})
}

func migrationFiles(l core.MigrationsList) []string {
	var files []string
	for _, m := range l.Items() {
		files = append(files, m.File)
	}
	return files
}

// Run backs dataDir up when the database has not applied every one of
// migrations, or stores a seed version other than a non-empty seedVersion. It
// returns the backup's path and why it was taken, or "" when nothing is about
// to change, a fresh install included.
//
// It must run before anything opens the database: the archive copies the
// SQLite files as they lie on disk, which is consistent only while no
// connection writes to them.
func Run(dataDir string, migrations []string, seedVersion string, now time.Time) (path, reason string, err error) {
	dbPath := filepath.Join(dataDir, "data.db")
	if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
		return "", "", nil
	}
	reason, err = pendingChange(dbPath, migrations, seedVersion)
	if err != nil || reason == "" {
		return "", "", err
	}

	name := Prefix + now.UTC().Format("20060102150405") + ".zip"
	tmp := filepath.Join(dataDir, core.LocalTempDirName, name)
	if err := archive.Create(dataDir, tmp,
		core.LocalBackupsDirName, core.LocalTempDirName, core.LocalNotifyDirName,
		core.LocalAutocertCacheDirName, "lost+found"); err != nil {
		return "", "", err
	}
	// Written aside and renamed in, so a crash or a full disk mid-archive
	// never leaves a truncated zip in the list a restore is picked from.
	backups := filepath.Join(dataDir, core.LocalBackupsDirName)
	// #nosec G301 -- the mode PocketBase's own backup code creates this directory with.
	if err := os.MkdirAll(backups, os.ModePerm); err != nil {
		return "", "", err
	}
	path = filepath.Join(backups, name)
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", "", err
	}
	if err := prune(backups, Keep); err != nil {
		log.Printf("shoppinglist: pruning old pre-upgrade backups failed: %v", err)
	}
	return path, reason, nil
}

// refuseNewer refuses a database that has applied a migration missing from
// migrations and named after newest, this binary's newest own one ([D-345]):
// a newer release changed it, and this binary's code over a schema it does
// not know is not a state anyone tested. That release backed pb_data up
// before the change. One named before it is a file PocketBase has since
// deleted, as it announces for its v0.23 upgrade. The names start with a
// 10-digit timestamp, so they sort by it.
func refuseNewer(dataDir string, migrations []string, newest string) error {
	dbPath := filepath.Join(dataDir, "data.db")
	if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	db, err := dbx.Open("sqlite", dbPath+"?_pragma=query_only(1)&_pragma=busy_timeout(10000)")
	if err != nil {
		return err
	}
	defer db.Close()
	applied, err := appliedMigrations(db)
	if err != nil {
		return err
	}
	var unknown []string
	for _, f := range applied {
		if f > newest && !slices.Contains(migrations, f) {
			unknown = append(unknown, f)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	return fmt.Errorf("pb_data was changed by a newer version of the server (%s), which this one cannot run on: "+
		"start that version again, or restore the backup it made before the change, pb_data/backups/%s<time>.zip "+
		"(docs/deploy-reference.md#upgrades)", strings.Join(unknown, ", "), Prefix)
}

// pendingChange reads the applied migrations and the stored seed version on a
// query-only connection closed before the archive is made. A database without
// the migrations table has never been bootstrapped and needs no backup.
func pendingChange(dbPath string, migrations []string, seedVersion string) (string, error) {
	db, err := dbx.Open("sqlite", dbPath+"?_pragma=query_only(1)&_pragma=busy_timeout(10000)")
	if err != nil {
		return "", err
	}
	defer db.Close()

	applied, err := appliedMigrations(db)
	if err != nil || applied == nil {
		return "", err
	}
	var pending []string
	for _, f := range migrations {
		if !slices.Contains(applied, f) {
			pending = append(pending, f)
		}
	}

	var reasons []string
	if len(pending) > 0 {
		reasons = append(reasons, fmt.Sprintf("%d pending migration(s): %s", len(pending), strings.Join(pending, ", ")))
	}
	if seedVersion != "" {
		stored, err := storedSeedVersion(db)
		if err != nil {
			return "", err
		}
		if stored != seedVersion {
			reasons = append(reasons, fmt.Sprintf("seed version %q -> %q", stored, seedVersion))
		}
	}
	return strings.Join(reasons, "; "), nil
}

// appliedMigrations is nil for a database without the migrations table, one
// that was never bootstrapped.
func appliedMigrations(db *dbx.DB) ([]string, error) {
	if ok, err := hasTable(db, "_migrations"); err != nil || !ok {
		return nil, err
	}
	applied := []string{}
	err := db.NewQuery("SELECT file FROM _migrations").Column(&applied)
	return applied, err
}

func hasTable(db *dbx.DB, name string) (bool, error) {
	var n int
	err := db.NewQuery("SELECT count(*) FROM sqlite_master WHERE type='table' AND name={:name}").
		Bind(dbx.Params{"name": name}).Row(&n)
	return n > 0, err
}

// storedSeedVersion mirrors seed.readSeedVersion over a raw connection: the
// `_params` row it writes holds a JSON string; missing or malformed reads "".
func storedSeedVersion(db *dbx.DB) (string, error) {
	if ok, err := hasTable(db, "_params"); err != nil || !ok {
		return "", err
	}
	var raw sql.NullString
	err := db.NewQuery("SELECT value FROM _params WHERE id = {:id}").
		Bind(dbx.Params{"id": seed.ParamKeySeedVersion}).Row(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var v string
	if json.Unmarshal([]byte(raw.String), &v) != nil {
		return "", nil
	}
	return v, nil
}

// prune removes all but the newest keep pre-upgrade backups. The timestamp in
// the name sorts lexically, and ReadDir returns names sorted, so name order is
// age order. Not filepath.Glob: dir is the operator's, and may hold a '['.
func prune(dir string, keep int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var ours []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), Prefix) && strings.HasSuffix(e.Name(), ".zip") {
			ours = append(ours, e.Name())
		}
	}
	var errs []error
	for _, name := range ours[:max(0, len(ours)-keep)] {
		errs = append(errs, os.Remove(filepath.Join(dir, name)))
	}
	return errors.Join(errs...)
}
