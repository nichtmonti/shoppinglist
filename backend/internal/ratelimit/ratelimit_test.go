package ratelimit

import (
	"fmt"
	"math/rand/v2"
	"testing"
	"time"
)

// TestLimiter: the per-IP limiter admits up to max, then rejects.
func TestLimiter(t *testing.T) {
	l := New(time.Minute, 3)
	for i := range 3 {
		if !l.Allow("1.2.3.4") {
			t.Errorf("attempt %d: want allowed", i+1)
		}
	}
	if l.Allow("1.2.3.4") {
		t.Error("4th attempt from same IP should be rejected")
	}
	if !l.Allow("9.9.9.9") {
		t.Error("a different IP should be unaffected")
	}
}

// TestLimiter_EvictsStaleIPs: one-shot IPs must not accumulate forever. Several
// limiters sit on unauthenticated routes, so the map has to shed addresses that
// stopped calling — not just the ones that call again.
func TestLimiter_EvictsStaleIPs(t *testing.T) {
	l := New(time.Minute, 3)

	clock := time.Now()
	l.now = func() time.Time { return clock }

	for i := range 500 {
		l.Allow(fmt.Sprintf("10.0.%d.%d", i/256, i%256))
	}
	if got := len(l.hits); got != 500 {
		t.Fatalf("before eviction: len(hits) = %d, want 500", got)
	}

	// Past the window, so every recorded hit is now stale. One more call from
	// one IP triggers the sweep.
	clock = clock.Add(2 * time.Minute)
	if !l.Allow("1.2.3.4") {
		t.Error("a fresh IP after the window should be allowed")
	}
	if got := len(l.hits); got != 1 {
		t.Errorf("after eviction: len(hits) = %d, want 1 (only the caller that swept)", got)
	}

	// The sweep must not cost an active IP its history.
	for range 2 {
		l.Allow("1.2.3.4")
	}
	if l.Allow("1.2.3.4") {
		t.Error("4th attempt within the window should be rejected after a sweep")
	}
}

// TestLimiter_FloodKeepsAtMostMaxPlusOne: an IP calling far past its budget
// keeps at most max+1 timestamps, and every call is answered exactly as by the
// unbounded sliding window (which records every attempt and counts the window).
func TestLimiter_FloodKeepsAtMostMaxPlusOne(t *testing.T) {
	const window, budget = time.Minute, 5
	l := New(window, budget)
	clock := time.Unix(0, 0)
	l.now = func() time.Time { return clock }

	rng := rand.New(rand.NewPCG(1, 2))
	all := map[string][]time.Time{} // the reference: every attempt, never cut
	ips := []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"}
	for i := range 20000 {
		// Mostly bursts far faster than the budget, sometimes a pause past it.
		step := time.Duration(rng.IntN(400)) * time.Millisecond
		if rng.IntN(500) == 0 {
			step = window + time.Second
		}
		clock = clock.Add(step)
		ip := ips[rng.IntN(len(ips))]
		all[ip] = append(all[ip], clock)
		inWindow := 0
		for _, ts := range all[ip] {
			if ts.After(clock.Add(-window)) {
				inWindow++
			}
		}
		if got, want := l.Allow(ip), inWindow <= budget; got != want {
			t.Fatalf("call %d from %s: Allow = %v, the unbounded window says %v", i, ip, got, want)
		}
		if n := len(l.hits[ip]); n > budget+1 {
			t.Fatalf("call %d: %s keeps %d timestamps, want at most %d", i, ip, n, budget+1)
		}
	}
}
