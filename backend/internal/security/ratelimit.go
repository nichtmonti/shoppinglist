package security

import (
	"net/netip"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/ratelimit"
)

// budgetName is typed so a call site cannot pass an arbitrary string.
type budgetName string

// The §10 rate-limit budgets.
const (
	RateSyncPush      budgetName = "sync_push"      // §10: the only sync write path
	RatePasskeyBegin  budgetName = "passkey_begin"  // §10: register+login begin share ONE budget
	RatePasskeyFinish budgetName = "passkey_finish" // §10: both finish routes
	RateInvitePreview budgetName = "invite_preview" // §10: unauthenticated
	RateInviteJoin    budgetName = "invite_join"    // §10
	RateInviteMint    budgetName = "invite_mint"    // link rotation, human pace
	RateBarcodeLookup budgetName = "barcode_lookup" // §10: authenticated Open Food Facts proxy
	RateBarcodePhoto  budgetName = "barcode_photo"  // unauthenticated (an <img> carries no token); one request per shop tile

	// Authenticated writes: AuthRoutes bounds who, not how often, and these
	// are where one member can multiply server-side state.
	RateListCreate        budgetName = "list_create"        // one row plus a category copy per call
	RateListImport        budgetName = "list_import"        // up to 2000 items per call — the amplifier
	RateListClone         budgetName = "list_clone"         // duplicates a whole list — the other amplifier
	RateClearHistory      budgetName = "clear_history"      // bulk UPDATE across a list
	RateMissingCategories budgetName = "missing_categories" // at most one row per template per call
	RateInviteRevoke      budgetName = "invite_revoke"      // mint's twin
	RateAccountWrite      budgetName = "account_write"      // delete / link / unlink / rotate-token-key, one bucket
	RateCredRename        budgetName = "cred_rename"        // §5.4 passkey label

	// Unauthenticated by design; bounds how fast anyone can fill the
	// operator's log ([D-197]).
	RateClientError budgetName = "client_error"
)

// budget is one row of the §10 rate-limit table.
type budget struct {
	window time.Duration
	max    int
}

// policy is the single table of §10 budgets. SetBudget overrides a row (tests)
// or adds one (the demo build's, so this table never names its route).
var policy = map[budgetName]budget{
	RateSyncPush:      {5 * time.Minute, 300},
	RatePasskeyBegin:  {time.Minute, 30},
	RatePasskeyFinish: {time.Minute, 30},
	RateInvitePreview: {time.Minute, 30},
	RateInviteJoin:    {time.Minute, 30},
	RateInviteMint:    {time.Minute, 30},
	RateBarcodeLookup: {time.Minute, 30},
	RateBarcodePhoto:  {time.Minute, 300},

	// Sized for a hand, not a script; import and clone are tightest because
	// one call writes thousands of rows.
	RateListCreate:        {5 * time.Minute, 30},
	RateListImport:        {5 * time.Minute, 10},
	RateListClone:         {5 * time.Minute, 10},
	RateClearHistory:      {5 * time.Minute, 30},
	RateMissingCategories: {5 * time.Minute, 30},
	RateInviteRevoke:      {time.Minute, 30},
	RateAccountWrite:      {time.Minute, 10},
	RateCredRename:        {time.Minute, 30},
	RateClientError:       {time.Minute, 10},
}

// Deliberately ABSENT from the table, left to PocketBase's /api/ catch-all:
//
//   - GET /api/sync/digest, polled every ~60s by every device (§8.5): a
//     per-IP budget would cut off a household whose phones share a NAT.
//   - GET /api/sync/snapshot/{listId}, the digest's repair read (§8.5): it runs
//     only for a diverged list, but for every list at once after an eviction
//     (§8.8), a repair a budget would stall.
//   - GET /api/lists/{listId}/members, a cheap read (§7.4).
//   - GET /api/seed-version, a constant.
//   - GET /api/auth/methods, one cached lookup (§5.9).
//
// mu guards limiters (and policy, via SetBudget).
var mu sync.Mutex

// limiters holds one limiter per budget, built lazily from policy.
var limiters = map[budgetName]*ratelimit.Limiter{}

// limiterFor returns the limiter for name. It panics on an unknown name, a
// programmer error never reachable from client input.
func limiterFor(name budgetName) *ratelimit.Limiter {
	mu.Lock()
	defer mu.Unlock()
	if l, ok := limiters[name]; ok {
		return l
	}
	b, ok := policy[name]
	if !ok {
		panic("security: unknown rate-limit budget " + name)
	}
	l := ratelimit.New(b.window, b.max)
	limiters[name] = l
	return l
}

// SetBudget sets a budget's window and max, adding the row if it is new, and
// re-arms its limiter with a fresh one.
func SetBudget(name budgetName, window time.Duration, max int) {
	mu.Lock()
	defer mu.Unlock()
	policy[name] = budget{window, max}
	limiters[name] = ratelimit.New(window, max)
}

// ResetLimiters discards every recorded hit, re-arming all budgets from the
// policy table on next use.
//
// Test support (internal/testutil.NewMux), never called from a serving
// process: every httptest request shares one IP, so without it one test that
// exhausts a bucket would 429 the next.
func ResetLimiters() {
	mu.Lock()
	defer mu.Unlock()
	clear(limiters)
}

// RateLimit returns middleware enforcing the named §10 budget per IP. The
// per-request lookup goes through limiters so SetBudget and ResetLimiters can
// re-arm a bound route's budget.
func RateLimit(name budgetName) func(*core.RequestEvent) error {
	// Panic on an unknown name at bind time: inside a request the router's
	// recover would turn it into a bare 500.
	limiterFor(name)
	return func(e *core.RequestEvent) error {
		if !limiterFor(name).Allow(clientKey(e.RealIP())) {
			return e.TooManyRequestsError("too many attempts, slow down", nil)
		}
		return e.Next()
	}
}

// clientKey is the bucket a client address counts against: an IPv4 address
// (an IPv4-mapped IPv6 one included) as it is, an IPv6 address by its /64.
// One subscriber line is routinely handed a whole /64, so per address it
// would get 2^64 budgets. A string that is not an address stays itself.
func clientKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.WithZone("").Prefix(64)
	if err != nil {
		return ip
	}
	return prefix.String()
}
