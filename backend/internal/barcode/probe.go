package barcode

import (
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/applog"
)

// probeBarcode is well-formed and held by no database, so each site answers
// it with a small 404, which counts as an answer like any other.
const probeBarcode = "0000000000000"

// The boot check asks up to probeAttempts times, probeWait apart, before it
// warns: an egress proxy started beside the app listens a few seconds after
// it, and the app does not wait for it ([D-260]).
var (
	probeAttempts = 10
	probeWait     = func() { time.Sleep(3 * time.Second) }
)

// Unreachable asks every product database a lookup can use for probeBarcode,
// all at once, through the same client as a lookup (its timeout, no
// redirects, HTTPS_PROXY). It returns "host, host (cause)" for the sites that
// gave no answer, grouped by cause, OFF first; empty means a scan can reach
// them all.
func Unreachable() []string {
	sites := []upstreamSite{offSite}
	for _, key := range slices.Sorted(maps.Keys(siblingSites)) {
		sites = append(sites, siblingSites[key])
	}
	causes := make([]error, len(sites))
	var wg sync.WaitGroup
	for i, site := range sites {
		wg.Go(func() { causes[i] = probeSite(site) })
	}
	wg.Wait()
	// No route out fails every site the same way; say the cause once.
	var order []string
	hosts := map[string][]string{}
	for i, err := range causes {
		if err == nil {
			continue
		}
		cause := err.Error()
		if _, seen := hosts[cause]; !seen {
			order = append(order, cause)
		}
		hosts[cause] = append(hosts[cause], siteHost(sites[i]))
	}
	out := make([]string, 0, len(order))
	for _, cause := range order {
		out = append(out, fmt.Sprintf("%s (%s)", strings.Join(hosts[cause], ", "), cause))
	}
	return out
}

// WarnIfUnreachable logs one warning naming every product database the
// server cannot reach, once probeAttempts have all found one down. It runs in
// the background at boot, so a slow or absent network never delays the start;
// a failed lookup itself still only tells the user "Product not found".
func WarnIfUnreachable(app core.App) {
	down := Unreachable()
	for attempt := 1; len(down) > 0 && attempt < probeAttempts; attempt++ {
		probeWait()
		down = Unreachable()
	}
	if len(down) > 0 {
		applog.Warn(app, "the barcode scanner cannot reach a product database — every scan ends in "+
			"\"Product not found\" until it can (docs/deploy-reference.md#hardening-notes)", nil,
			"unreachable", strings.Join(down, "; "))
	}
}

// probeSite reports why site gave no answer, or nil when it answered: any
// 2xx or 404, as queryUpstream accepts.
func probeSite(site upstreamSite) error {
	resp, err := upstreamGet(fmt.Sprintf(site.URL, probeBarcode) + upstreamFields)
	if err != nil {
		// The URL is in the warning already; keep only the cause.
		if urlErr, ok := errors.AsType[*url.Error](err); ok {
			return urlErr.Err
		}
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	return fmt.Errorf("HTTP %d", resp.StatusCode)
}

// siteHost is site's host name; the URL template's %s is not a valid escape,
// so it is filled in before parsing.
func siteHost(site upstreamSite) string {
	if u, err := url.Parse(fmt.Sprintf(site.URL, probeBarcode)); err == nil && u.Host != "" {
		return u.Host
	}
	return site.URL
}
