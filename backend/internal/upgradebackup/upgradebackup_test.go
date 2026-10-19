package upgradebackup

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
	"shoppinglist/seed"
)

// upToDate returns a pb_data dir as a previous release left it: every
// migration this binary knows applied, the current seed stored, database
// closed.
func upToDate(t *testing.T) (dir string, migrations []string) {
	t.Helper()
	app := testutil.NewApp(t)
	if err := seed.Run(app); err != nil {
		t.Fatalf("seed: %v", err)
	}
	dir = app.DataDir()
	if err := app.ClearBootstrap(); err != nil {
		t.Fatalf("close: %v", err)
	}
	all := append(migrationFiles(core.SystemMigrations), migrationFiles(core.AppMigrations)...)
	return dir, all
}

var t0 = time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

func TestFreshInstallIsNotBackedUp(t *testing.T) {
	dir := t.TempDir()
	path, _, err := Run(dir, []string{"1_x.go"}, "4", t0)
	if err != nil || path != "" {
		t.Fatalf("Run on an empty dir = %q, %v; want no backup", path, err)
	}
	if _, err := os.Stat(filepath.Join(dir, core.LocalBackupsDirName)); !os.IsNotExist(err) {
		t.Fatalf("backups dir created on a fresh install: %v", err)
	}
}

func TestNothingPendingIsNotBackedUp(t *testing.T) {
	dir, migrations := upToDate(t)
	path, reason, err := Run(dir, migrations, seed.CurrentSeedVersion, t0)
	if err != nil || path != "" {
		t.Fatalf("Run = %q (%s), %v; want no backup on a plain restart", path, reason, err)
	}
}

func TestPendingMigrationIsBackedUp(t *testing.T) {
	dir, migrations := upToDate(t)
	migrations = append(migrations, "1999999999_next_release.go")

	path, reason, err := Run(dir, migrations, seed.CurrentSeedVersion, t0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(reason, "1999999999_next_release.go") {
		t.Errorf("reason %q does not name the pending migration", reason)
	}
	if want := filepath.Join(dir, "backups", "pb_backup_pre_upgrade_20260927120000.zip"); path != want {
		t.Fatalf("path = %q, want %q", path, want)
	}
	// PocketBase's restore route refuses any other name shape.
	if !regexp.MustCompile(`^[a-z0-9_-]+\.zip$`).MatchString(filepath.Base(path)) {
		t.Errorf("%q is not a name PocketBase can restore", filepath.Base(path))
	}
	assertRestorable(t, path, len(migrations)-1)
	if entries, _ := os.ReadDir(filepath.Join(dir, core.LocalTempDirName)); len(entries) != 0 {
		t.Errorf("temp archive left behind: %v", entries)
	}
}

func TestSeedBumpIsBackedUp(t *testing.T) {
	dir, migrations := upToDate(t)
	path, reason, err := Run(dir, migrations, "next", t0)
	if err != nil || path == "" {
		t.Fatalf("Run = %q, %v; want a backup for a new seed", path, err)
	}
	if !strings.Contains(reason, `"`+seed.CurrentSeedVersion+`" -> "next"`) {
		t.Errorf("reason %q does not name the seed change", reason)
	}
	// "" means the invocation does not seed, so the version is not compared.
	path, _, err = Run(dir, migrations, "", t0.Add(time.Second))
	if err != nil || path != "" {
		t.Fatalf("Run without a seed version = %q, %v; want no backup", path, err)
	}
}

// assertRestorable unzips the backup and opens the database in it: the
// snapshot holds the applied migrations, and not the backups dir itself.
func assertRestorable(t *testing.T, path string, wantApplied int) {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	out := t.TempDir()
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
		if strings.HasPrefix(f.Name, "backups/") || strings.HasPrefix(f.Name, core.LocalTempDirName) {
			t.Errorf("backup contains %s", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(out, f.Name)
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		b, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Contains(names, "data.db") {
		t.Fatalf("backup has no data.db: %v", names)
	}
	db, err := dbx.Open("sqlite", filepath.Join(out, "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.NewQuery("SELECT count(*) FROM _migrations").Row(&n); err != nil {
		t.Fatal(err)
	}
	if n != wantApplied {
		t.Errorf("restored database has %d applied migrations, want %d", n, wantApplied)
	}
}

func TestPruneKeepsTheNewestOwnBackups(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{
		Prefix + "20260101000000.zip", Prefix + "20260201000000.zip",
		Prefix + "20260301000000.zip", Prefix + "20260401000000.zip",
		"pb_backup_mine_20200101000000.zip", // the operator's own: never touched
	} {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := prune(dir, 3); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	want := []string{
		"pb_backup_mine_20200101000000.zip",
		Prefix + "20260201000000.zip", Prefix + "20260301000000.zip", Prefix + "20260401000000.zip",
	}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("after prune: %v, want %v", got, want)
	}
}

// The hook, bound as main binds it, runs ahead of PocketBase's bootstrap: a
// database behind this binary is backed up before anything opens it.
func TestRegisterBacksUpBeforeBootstrap(t *testing.T) {
	dir, _ := upToDate(t)
	// Rewind the seed so a serve boot of this binary would change the data.
	db, err := dbx.Open("sqlite", filepath.Join(dir, "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.NewQuery(`UPDATE _params SET value='"0"' WHERE id='seed_version'`).Execute(); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dir, HideStartBanner: true})
	Register(app, true)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	defer app.ClearBootstrap()
	entries, _ := os.ReadDir(filepath.Join(dir, "backups"))
	if len(entries) != 1 || !strings.HasPrefix(entries[0].Name(), Prefix) {
		t.Fatalf("backups after a boot with a seed change: %v", entries)
	}
}

// A non-serve subcommand runs no app migration and no seed, so the same
// state is left alone.
func TestRegisterWithoutAppMigrationsIgnoresSeed(t *testing.T) {
	dir, _ := upToDate(t)
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dir, HideStartBanner: true})
	Register(app, false)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	defer app.ClearBootstrap()
	if _, err := os.Stat(filepath.Join(dir, "backups")); !os.IsNotExist(err) {
		t.Fatalf("backups dir after a non-serve boot: %v", err)
	}
}

// [D-183] A backup that cannot be written refuses the boot, before anything
// migrates: here pb_data/backups is a file, so the directory cannot be made,
// and the system migration left pending stays unapplied.
func TestFailedBackupRefusesTheBoot(t *testing.T) {
	dir, _ := upToDate(t)
	pending := migrationFiles(core.SystemMigrations)[0]
	db, err := dbx.Open("sqlite", filepath.Join(dir, "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.NewQuery("DELETE FROM _migrations WHERE file = {:f}").Bind(dbx.Params{"f": pending}).Execute(); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if err := os.WriteFile(filepath.Join(dir, core.LocalBackupsDirName), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dir, HideStartBanner: true})
	Register(app, true)
	err = app.Bootstrap()
	defer app.ClearBootstrap()
	if err == nil || !strings.Contains(err.Error(), "pre-upgrade backup failed") {
		t.Fatalf("Bootstrap = %v, want the pre-upgrade backup refusal", err)
	}

	db, err = dbx.Open("sqlite", filepath.Join(dir, "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.NewQuery("SELECT count(*) FROM _migrations WHERE file = {:f}").Bind(dbx.Params{"f": pending}).Row(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%s was applied although the backup failed", pending)
	}
}

// A backup that cannot be moved into place leaves no half-made zip behind in
// pb_data's temp directory.
func TestFailedRenameRemovesTheTempArchive(t *testing.T) {
	dir, migrations := upToDate(t)
	name := Prefix + t0.Format("20060102150405") + ".zip"
	// A non-empty directory where the zip would land: the rename fails.
	blocker := filepath.Join(dir, core.LocalBackupsDirName, name)
	if err := os.MkdirAll(blocker, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocker, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Run(dir, migrations, "next", t0); err == nil {
		t.Fatal("Run succeeded although the backup could not be moved into place")
	}
	if _, err := os.Stat(filepath.Join(dir, core.LocalTempDirName, name)); !os.IsNotExist(err) {
		t.Errorf("temp archive left behind: %v", err)
	}
}
