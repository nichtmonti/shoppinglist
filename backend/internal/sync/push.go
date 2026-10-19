package sync

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"shoppinglist/internal/applog"
	"shoppinglist/internal/fieldcontract"
	"shoppinglist/internal/listcap"
	"shoppinglist/internal/members"
	"shoppinglist/internal/records"
)

// pushHandler implements POST /api/sync/push (§8.3): the only write path for
// items and list_categories. Each op runs in its own transaction, for partial
// progress on a flaky link.
func pushHandler(maxItems int) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		var body struct {
			Ops []pushOp `json:"ops"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("invalid request body", err)
		}
		// The client chunks its drain to this same bound (field-contract.json), so
		// a long outbox never deadlocks on this 400.
		if len(body.Ops) > fieldcontract.MaxOpsPerPush() {
			return e.BadRequestError("too many ops in a single request", nil)
		}
		for _, op := range body.Ops {
			if len(op.OpID) > maxOpIDBytes {
				return e.BadRequestError("op_id too long", nil)
			}
		}
		membership := newMembershipCache(e.App, e.Auth.Id)
		results := make([]pushResult, 0, len(body.Ops))
		for _, op := range body.Ops {
			r, err := processOp(e.App, op, e.Auth.Id, membership, maxItems)
			if err != nil {
				// Not a verdict: an op without a result stays queued and is
				// retried ([D-191]).
				applog.Warn(e.App, "sync push: op not settled", err, "op", op.OpID, "collection", op.Collection)
				continue
			}
			results = append(results, r)
		}
		return e.JSON(http.StatusOK, map[string]any{"results": results})
	}
}

// membershipCache answers "is the caller a member of this list" once per list
// per push request. Only answers are cached; a failed lookup is asked again.
type membershipCache struct {
	app      core.App
	callerID string
	known    map[string]bool
}

func newMembershipCache(app core.App, callerID string) *membershipCache {
	return &membershipCache{app: app, callerID: callerID, known: map[string]bool{}}
}

func (m *membershipCache) isMember(listID string) (bool, error) {
	if ok, seen := m.known[listID]; seen {
		return ok, nil
	}
	ok, err := members.IsMember(m.app, m.callerID, listID)
	if err != nil {
		return false, err
	}
	m.known[listID] = ok
	return ok, nil
}

// listGone reports whether listID no longer exists. That is what the `gone`
// status means, and the client answers it by purging the whole list (§8.6).
func listGone(txApp core.App, listID string) (bool, error) {
	list, err := records.FindOptional(txApp, "lists", listID)
	if err != nil {
		return false, err
	}
	return list == nil, nil
}

// listFull reports whether listID already holds as many rows of collection as
// a list may: maxItems items, listcap.MaxCategories categories. Every row
// counts, tombstones too, because the cap bounds storage.
func listFull(txApp core.App, collection, listID string, maxItems int) (bool, error) {
	limit := maxItems
	if collection == collectionCategories {
		limit = listcap.MaxCategories
	}
	n, err := txApp.CountRecords(collection, dbx.HashExp{"list": listID})
	return n >= int64(limit), err
}

func goneResult(op pushOp) pushResult {
	return pushResult{OpID: op.OpID, Status: statusGone}
}

func denied(op pushOp, reason string) pushResult {
	return pushResult{OpID: op.OpID, Status: statusDenied, Reason: reason}
}

// deniedField is a denial scoped to one field of the op.
func deniedField(op pushOp, reason, field string) pushResult {
	r := denied(op, reason)
	r.Field = field
	return r
}

// inTx runs fn in one transaction and answers the result it settles on.
func inTx(app core.App, fn func(txApp core.App) (pushResult, error)) (pushResult, error) {
	var result pushResult
	err := app.RunInTransaction(func(txApp core.App) error {
		var err error
		result, err = fn(txApp)
		return err
	})
	return result, err
}

// processOp handles a single sync op in its own transaction. An error is a
// failure to settle it, never a verdict.
func processOp(app core.App, op pushOp, callerID string, membership *membershipCache, maxItems int) (pushResult, error) {
	// Validation + authorise (§8.3 step 1).
	if op.Collection != collectionItems && op.Collection != collectionCategories {
		return denied(op, reasonBadCollection), nil
	}
	if op.ListID == "" {
		return denied(op, reasonBadList), nil
	}
	if op.Type != "create" && op.Type != "update" {
		return denied(op, reasonBadType), nil
	}
	// [D-266] The server stamps image_url from the barcode; a client from
	// before still sends one. Dropped, not refused: a refusal would lose the
	// whole queued create.
	delete(op.Changed, "image_url")
	// Field allowlist, byte caps and bool shapes (fieldlimits.go). A smuggled
	// `list` would escape the membership check below. A legit client can still
	// hit a cap: `maxlength` counts UTF-16 units, the cap UTF-8 bytes.
	unknown, oversized, badType := fieldProblems(op.Collection, op.Changed)
	if unknown != "" {
		return deniedField(op, reasonFieldUnknown, unknown), nil
	}
	if badType != "" {
		return deniedField(op, reasonFieldInvalid, badType), nil
	}
	if oversized != "" {
		return deniedField(op, reasonFieldTooLong, oversized), nil
	}

	// A failed lookup is not a verdict: not_member is terminal, and the client
	// drops the op without a toast.
	member, err := membership.isMember(op.ListID)
	if err != nil {
		return pushResult{}, err
	}
	if !member {
		return denied(op, reasonNotMember), nil
	}

	if op.Type == "create" {
		// [D-08] bound the client-minted id before freshInsert saves it.
		// Create only: an update writes no new id.
		if !recordIDPattern.MatchString(op.RecordID) {
			return denied(op, reasonBadRecordID), nil
		}
		return processCreate(app, op, callerID, maxItems)
	}
	return processUpdate(app, op, callerID)
}

// freshInsert creates the record from op.Changed.
func freshInsert(txApp core.App, op pushOp, callerID string) (pushResult, error) {
	// Cached lookup: this runs per create op, and the uncached variant
	// re-hydrates the whole schema every call. Safe because no collection is
	// mutated in these transactions.
	col, err := txApp.FindCachedCollectionByNameOrId(op.Collection)
	if err != nil {
		return pushResult{}, err
	}
	rec := core.NewRecord(col)
	rec.Id = op.RecordID

	for field, val := range op.Changed {
		if isSignal(field) {
			continue
		}
		rec.Set(field, val)
	}

	// Server-owned fields are set AFTER the op's fields, so they win outright
	// (the allowlist already refuses them; this is defence in depth).
	rec.Set("list", op.ListID)
	rec.Set("modified_by", callerID)

	if boolFromChanged(op.Changed, "deleted") {
		rec.Set("deleted_at", now())
	}
	if boolFromChanged(op.Changed, "checked") {
		stampChecked(rec, true)
	}

	if err := txApp.SaveNoValidate(rec); err != nil {
		return pushResult{}, err
	}

	return pushResult{
		OpID:   op.OpID,
		Status: statusApplied,
		Record: recordMap(op.Collection, rec),
	}, nil
}

// processCreate handles create ops.
func processCreate(app core.App, op pushOp, callerID string, maxItems int) (pushResult, error) {
	return inTx(app, func(txApp core.App) (pushResult, error) {
		// The membership check usually preempts this (§7.3 cascade), but a
		// stale-membership window would let SaveNoValidate store an orphan.
		if gone, err := listGone(txApp, op.ListID); err != nil || gone {
			return goneResult(op), err
		}

		// Duplicate-record_id check FIRST ([D-42]).
		existing, err := records.FindOptional(txApp, op.Collection, op.RecordID)
		if err != nil {
			return pushResult{}, err
		}
		if existing != nil {
			if existing.GetString("list") != op.ListID {
				// The id names another list's row: the insert could never
				// succeed, so this is a verdict, not a failure to retry.
				return denied(op, reasonBadRecordID), nil
			}
			return pushResult{
				OpID:   op.OpID,
				Status: statusNoop,
				Record: recordMap(op.Collection, existing),
			}, nil
		}

		if op.Collection == collectionItems {
			// The same check for an id already consumed in a merge ([D-108]).
			// Must run BEFORE mergeByNormalizedName, which it stops running twice.
			if replayed, ok, err := replayMerge(txApp, op); err != nil || ok {
				return replayed, err
			}

			if merged, ok, err := mergeByNormalizedName(txApp, op, callerID); err != nil || ok {
				return merged, err
			}
		}

		// [D-217] Only now is this op known to add a row.
		if full, err := listFull(txApp, op.Collection, op.ListID, maxItems); err != nil || full {
			return denied(op, reasonListFull), err
		}

		return freshInsert(txApp, op, callerID)
	})
}

// processUpdate handles update ops.
func processUpdate(app core.App, op pushOp, callerID string) (pushResult, error) {
	return inTx(app, func(txApp core.App) (pushResult, error) {
		current, err := records.FindOptional(txApp, op.Collection, op.RecordID)
		if err != nil {
			return pushResult{}, err
		}
		if current == nil {
			// WHICH gone decides the client's reaction ([D-103]): `gone` purges
			// the whole LIST (§8.6), which is wrong when tombstone GC swept one
			// row. The list record, read in the same transaction, decides.
			if gone, err := listGone(txApp, op.ListID); err != nil || gone {
				return goneResult(op), err
			}
			return denied(op, reasonRowMissing), nil
		}
		if current.GetString("list") != op.ListID {
			// Outside the op's scope: `denied`, NOT `gone` (which purges the list).
			return denied(op, reasonWrongList), nil
		}
		delivery := deliveryID(op)
		if decided(current, delivery) {
			return replayUpdate(op, current), nil
		}
		result, err := decideUpdate(txApp, op, current, callerID)
		if err != nil || result.Status == statusDenied || result.Status == statusMerged {
			// A denial changed nothing; a merge logs itself ([D-108]).
			return result, err
		}
		return result, rememberDelivery(txApp, op.Collection, current, delivery)
	})
}

// decideUpdate is §8.3 step 3 on a row the op may change.
func decideUpdate(txApp core.App, op pushOp, current *core.Record, callerID string) (pushResult, error) {
	settled, err := tombstoneVerdict(txApp, op, current, callerID)
	if err != nil {
		return pushResult{}, err
	}
	if settled != nil {
		return *settled, nil
	}

	conflicts, applied := mergeFields(op, current)
	if stampSignals(op, current) {
		applied = true
	}

	status := statusNoop
	if len(conflicts) > 0 {
		status = statusPartial
	} else if applied {
		status = statusApplied
	}

	if applied {
		current.Set("modified_by", callerID)
		if err := txApp.SaveNoValidate(current); err != nil {
			return pushResult{}, err
		}
	}

	return pushResult{
		OpID:      op.OpID,
		Status:    status,
		Record:    recordMap(op.Collection, current),
		Conflicts: conflicts,
	}, nil
}

func now() types.DateTime { return types.NowDateTime() }
