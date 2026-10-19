package sync

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	gosync "sync"
	"testing"

	"github.com/pocketbase/dbx"

	"shoppinglist/internal/normalize"
	"shoppinglist/internal/randid"
	"shoppinglist/internal/testutil"
)

// Members pushing to one list at the same instant, each push also sent twice
// as a lost answer's retry would be: the per-op transactions must still leave
// one living row per name ([D-29]), lose no create, and answer every op.
func TestPush_ParallelMembers_OneLivingRowPerName(t *testing.T) {
	app, mux := setupSyncApp(t)
	owner, _ := testutil.CreateAccount(t, app, "Owner")
	listID := testutil.CreateListFor(t, app, owner, "Test")
	pool := []string{"Milch", "milch", "Brot", " BROT ", "Käse", "Eier"}
	const members, rounds = 4, 12

	var mu gosync.Mutex
	created := map[string]bool{} // normalized names a create carried
	var unanswered int
	var wg gosync.WaitGroup
	for m := range members {
		acct, tok := testutil.CreateAccount(t, app, fmt.Sprintf("M%d", m))
		addMembership(t, app, acct, listID)
		wg.Go(func() {
			r := rand.New(rand.NewPCG(uint64(m), 1))
			var mine []string // rows this member created or merged into
			for range rounds {
				var ops []pushOp
				for range 3 {
					name := pool[r.IntN(len(pool))]
					ops = append(ops, pushOp{OpID: randid.ID(), Collection: collectionItems,
						RecordID: randid.ID(), ListID: listID, Type: "create",
						Changed: map[string]any{"name": name, "quantity": fmt.Sprint(r.IntN(5))}})
					mu.Lock()
					created[normalize.Name(name)] = true
					mu.Unlock()
				}
				if len(mine) > 0 {
					id := mine[r.IntN(len(mine))]
					del := r.IntN(2) == 0
					ops = append(ops, pushOp{OpID: randid.ID(), Collection: collectionItems,
						RecordID: id, ListID: listID, Type: "update",
						Changed: map[string]any{"deleted": del}})
				}
				body, _ := json.Marshal(map[string]any{"ops": ops})
				var answers [2][]pushResult
				var both gosync.WaitGroup
				for i := range answers {
					both.Go(func() {
						rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/sync/push", string(body), testutil.AuthHeader(tok))
						if rec.Code != http.StatusOK {
							t.Errorf("push status %d: %s", rec.Code, rec.Body.String())
							return
						}
						var resp struct{ Results []pushResult }
						_ = json.Unmarshal(rec.Body.Bytes(), &resp)
						answers[i] = resp.Results
					})
				}
				both.Wait()
				mu.Lock()
				unanswered += 2*len(ops) - len(answers[0]) - len(answers[1])
				mu.Unlock()
				for _, res := range answers[0] {
					switch {
					case res.Status == statusMerged:
						mine = append(mine, res.RecordID)
					case res.Status == statusApplied && res.Record != nil:
						mine = append(mine, res.Record["id"].(string))
					}
				}
			}
		})
	}
	wg.Wait()

	rows, err := app.FindAllRecords(collectionItems, dbx.HashExp{"list": listID})
	if err != nil {
		t.Fatal(err)
	}
	living := map[string]int{}
	present := map[string]bool{}
	for _, row := range rows {
		norm := normalize.Name(row.GetString("name"))
		present[norm] = true
		if row.GetString("deleted_at") == "" {
			living[norm]++
		}
	}
	for norm, n := range living {
		if n > 1 {
			t.Errorf("%q has %d living rows, want one", norm, n)
		}
	}
	for norm := range created {
		if !present[norm] {
			t.Errorf("%q was created and has no row", norm)
		}
	}
	if unanswered > 0 {
		t.Logf("%d op deliveries went unanswered (left queued for a retry)", unanswered)
	}
}
