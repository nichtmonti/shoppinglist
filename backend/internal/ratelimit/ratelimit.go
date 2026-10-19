// Package ratelimit provides a per-IP sliding-window rate limiter for a single
// instance, the mechanism behind every §10 budget in internal/security.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter is a minimal sliding-window per-IP rate limiter.
type Limiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	hits   map[string][]time.Time

	// lastSweep drives the eviction pass in Allow. Without it an IP that hits
	// once keeps its entry forever, and limiters on unauthenticated routes would
	// let an address scan grow the map without bound.
	lastSweep time.Time

	// now is injectable so the eviction pass can be tested without sleeping.
	now func() time.Time
}

// New returns a Limiter admitting up to max calls per IP within window.
func New(window time.Duration, max int) *Limiter {
	return &Limiter{
		window: window,
		max:    max,
		hits:   make(map[string][]time.Time),
		now:    time.Now,
	}
}

// Allow reports whether ip is under the limit, recording the attempt either way.
func (l *Limiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-l.window)

	l.sweep(now, cutoff)

	fresh := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if t.After(cutoff) {
			fresh = append(fresh, t)
		}
	}
	fresh = append(fresh, now)
	allowed := len(fresh) <= l.max
	// A refused call is recorded too, so an IP that keeps calling stays
	// refused; but only the newest max+1 can decide a later call (it is
	// refused while max of them are in the window), so the rest go. Without
	// the cut a flood grew the slice with its request rate.
	if len(fresh) > l.max+1 {
		fresh = fresh[:copy(fresh, fresh[len(fresh)-l.max-1:])]
	}
	l.hits[ip] = fresh
	return allowed
}

// sweep drops every IP whose most recent hit has aged out of the window, at
// most once per window, under the caller's lock.
func (l *Limiter) sweep(now, cutoff time.Time) {
	if now.Sub(l.lastSweep) < l.window {
		return
	}
	l.lastSweep = now

	for ip, hits := range l.hits {
		// Timestamps are appended in order, so the last one is the newest.
		if len(hits) == 0 || !hits[len(hits)-1].After(cutoff) {
			delete(l.hits, ip)
		}
	}
}
