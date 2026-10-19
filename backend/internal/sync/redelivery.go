package sync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// keptDeliveries is how many decided update deliveries a row remembers
// ([D-42]): a retry is answered from its first verdict while fewer than this
// many later ones were decided on the same row, which covers any realistic
// gap between a lost answer and its retry. Bounded per row, so the item cap
// ([D-217]) bounds it per list.
const keptDeliveries = 8

// deliveryID names one update payload: its op id with the exact fields it
// carries. A client re-sends an unanswered payload unchanged, and sends edits
// made meanwhile under the same op id with other fields, which are a new
// delivery ([D-40]).
func deliveryID(op pushOp) string {
	payload, _ := json.Marshal([]any{op.OpID, op.Changed, op.Base})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:12])
}

// decided reports whether the row already holds a verdict on this delivery.
func decided(row *core.Record, delivery string) bool {
	return slices.Contains(strings.Fields(row.GetString("deliveries")), delivery)
}

// rememberDelivery adds delivery to the row's decided deliveries, the newest
// keptDeliveries kept. A raw UPDATE: the row's `updated` and the realtime
// feed stay as the verdict left them, so a no-op stays one for every member.
func rememberDelivery(txApp core.App, collection string, row *core.Record, delivery string) error {
	kept := append(strings.Fields(row.GetString("deliveries")), delivery)
	kept = kept[max(0, len(kept)-keptDeliveries):]
	_, err := txApp.DB().Update(collection, dbx.Params{"deliveries": strings.Join(kept, " ")},
		dbx.HashExp{"id": row.Id}).Execute()
	return err
}

// replayUpdate answers an update the server already decided ([D-42]): nothing
// is applied again, since what it would apply was either applied then or
// refused then, and anything written since is a later edit. Conflicts are
// recomputed against the row as it is now, as for a merge.
func replayUpdate(op pushOp, current *core.Record) pushResult {
	var conflicts []conflictEntry
	for _, field := range sortedFields(op.Changed) {
		if !isSignal(field) && jsonCanonical(current.Get(field)) != jsonCanonical(op.Changed[field]) {
			conflicts = append(conflicts, conflictWith(current, field, op.Changed[field]))
		}
	}
	status := statusNoop
	if len(conflicts) > 0 {
		status = statusPartial
	}
	return pushResult{OpID: op.OpID, Status: status, Record: recordMap(op.Collection, current), Conflicts: conflicts}
}
