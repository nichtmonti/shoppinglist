package sync

import (
	"testing"

	"shoppinglist/internal/fieldcontract"
)

// TestReasonCodesMatchContract pins the ten `denied` reason consts to the
// shared field contract, the single source the const block and the client's
// DeniedReason union both read, so a code added on one side cannot be
// missing on the other.
func TestReasonCodesMatchContract(t *testing.T) {
	consts := map[string]bool{
		reasonBadCollection: true,
		reasonBadList:       true,
		reasonBadType:       true,
		reasonFieldUnknown:  true,
		reasonFieldInvalid:  true,
		reasonFieldTooLong:  true,
		reasonNotMember:     true,
		reasonWrongList:     true,
		reasonProtectedRow:  true,
		reasonBadRecordID:   true,
		reasonRowMissing:    true,
		reasonListFull:      true,
	}
	contract := map[string]bool{}
	for _, code := range fieldcontract.DeniedReasons() {
		contract[code] = true
	}
	// Set equality, both directions: no const missing from the contract, no
	// contract entry without a const.
	for code := range consts {
		if !contract[code] {
			t.Errorf("reason const %q is missing from fieldcontract.DeniedReasons()", code)
		}
	}
	for code := range contract {
		if !consts[code] {
			t.Errorf("fieldcontract.DeniedReasons() carries %q with no reason const", code)
		}
	}
}

// TestPushStatusesMatchContract pins the pushStatus consts to the contract's
// push_statuses, which the client's PUSH_STATUSES is pinned to as well.
func TestPushStatusesMatchContract(t *testing.T) {
	consts := []pushStatus{
		statusApplied, statusPartial, statusNoop, statusMerged,
		statusDeletedConflict, statusGone, statusDenied,
	}
	contract := map[string]bool{}
	for _, s := range fieldcontract.PushStatuses() {
		contract[s] = true
	}
	if len(contract) != len(consts) {
		t.Errorf("fieldcontract.PushStatuses() = %v, want the %d wire consts", fieldcontract.PushStatuses(), len(consts))
	}
	for _, s := range consts {
		if !contract[string(s)] {
			t.Errorf("push status const %q is missing from fieldcontract.PushStatuses()", s)
		}
	}
}
