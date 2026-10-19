package migrations

import (
	"fmt"
	"testing"

	"github.com/pocketbase/pocketbase"
)

// sqlExec runs one raw statement, bypassing the record pipeline so the rows
// look exactly like deployed data (explicit created stamps included).
func sqlExec(t *testing.T, app *pocketbase.PocketBase, format string, args ...any) {
	t.Helper()
	if _, err := app.DB().NewQuery(fmt.Sprintf(format, args...)).Execute(); err != nil {
		t.Fatalf("exec %q: %v", fmt.Sprintf(format, args...), err)
	}
}

func listName(t *testing.T, app *pocketbase.PocketBase, id string) string {
	t.Helper()
	var name string
	if err := app.DB().NewQuery("SELECT name FROM lists WHERE id = {:id}").
		Bind(map[string]any{"id": id}).Row(&name); err != nil {
		t.Fatalf("read lists.name of %s: %v", id, err)
	}
	return name
}

// TestGlobalListNameBackfill ([D-08]): against DEPLOYED data — per-member
// names on memberships — the up migration names each list after its EARLIEST
// membership (ORDER BY created, id), leaves a list nobody named empty, and
// drops the per-member columns and the memberships UpdateRule. The down
// migration hands every member the list's one name back.
//
// The pre-[D-08] schema is rebuilt by running the down migration on a fully
// migrated app, which is also the down migration's own round-trip test.
func TestGlobalListNameBackfill(t *testing.T) {
	app := newMigratedApp(t)

	// A named list with a member, to see the down migration copy the name out.
	sqlExec(t, app, `INSERT INTO lists (id, name, created, updated) VALUES ('listdown', 'Familie', '2026-01-01 00:00:00.000Z', '2026-01-01 00:00:00.000Z')`)
	sqlExec(t, app, `INSERT INTO memberships (id, account, list, created, updated) VALUES ('mdown', 'acct1', 'listdown', '2026-01-01 00:00:00.000Z', '2026-01-01 00:00:00.000Z')`)

	if err := globalListNameDown(app); err != nil {
		t.Fatalf("down: %v", err)
	}
	var restored string
	if err := app.DB().NewQuery("SELECT display_name FROM memberships WHERE id = 'mdown'").Row(&restored); err != nil {
		t.Fatalf("read restored display_name: %v", err)
	}
	if restored != "Familie" {
		t.Errorf("down: membership display_name = %q, want the list's name %q", restored, "Familie")
	}

	// Deployed state: lists have no name, members name them privately.
	for _, l := range []string{"listearly", "listtie", "listnone"} {
		sqlExec(t, app, `INSERT INTO lists (id, created, updated) VALUES ('%s', '2026-01-01 00:00:00.000Z', '2026-01-01 00:00:00.000Z')`, l)
	}
	mem := func(id, account, list, created, name string) {
		sqlExec(t, app, `INSERT INTO memberships (id, account, list, created, updated, display_name) VALUES ('%s', '%s', '%s', '%s', '%s', '%s')`,
			id, account, list, created, created, name)
	}
	// Inserted later-first, so neither rowid nor insertion order gives the
	// right answer by accident.
	mem("zzlate", "acct1", "listearly", "2026-03-01 00:00:00.000Z", "Spät")
	mem("zzearly", "acct2", "listearly", "2026-02-01 00:00:00.000Z", "Früh")
	// Same created: the id breaks the tie.
	mem("bbb", "acct1", "listtie", "2026-02-01 00:00:00.000Z", "Zweiter")
	mem("aaa", "acct2", "listtie", "2026-02-01 00:00:00.000Z", "Erster")

	if err := globalListNameUp(app); err != nil {
		t.Fatalf("up: %v", err)
	}

	for list, want := range map[string]string{
		"listearly": "Früh",
		"listtie":   "Erster",
		"listnone":  "",
		"listdown":  "Familie",
	} {
		if got := listName(t, app, list); got != want {
			t.Errorf("lists.name of %s = %q, want %q", list, got, want)
		}
	}

	// The per-member columns are gone, and with them the memberships UpdateRule.
	memberships, err := app.FindCollectionByNameOrId("memberships")
	if err != nil {
		t.Fatal(err)
	}
	if memberships.Fields.GetByName("display_name") != nil {
		t.Error("memberships.display_name survived the up migration")
	}
	if memberships.UpdateRule != nil {
		t.Errorf("memberships.UpdateRule = %q, want nil (superuser only)", *memberships.UpdateRule)
	}
	invites, err := app.FindCollectionByNameOrId("invites")
	if err != nil {
		t.Fatal(err)
	}
	if invites.Fields.GetByName("display_name") != nil {
		t.Error("invites.display_name survived the up migration")
	}
	lists, err := app.FindCollectionByNameOrId("lists")
	if err != nil {
		t.Fatal(err)
	}
	if lists.UpdateRule == nil {
		t.Error("lists.UpdateRule = nil, want the membership rule")
	} else if *lists.UpdateRule != membershipRule("id") {
		t.Errorf("lists.UpdateRule = %q, want the membership rule", *lists.UpdateRule)
	}
}
