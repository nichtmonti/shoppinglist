// Package envflag holds the environment checks that are not one setting's
// value ([D-61]): the names set that no setting has, and what a URL setting
// must look like. The settings themselves are internal/settings' ([D-337]).
package envflag

import (
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
)

// AbsoluteURL refuses anything but an absolute http or https URL. It is
// stricter than PocketBase's own validation (which accepts scheme-less hosts)
// because a URL without scheme or host breaks every URL built from it, and
// every URL setting is a web address: another scheme (javascript:, as a link's
// href) fails at boot too.
func AbsoluteURL(v string) error {
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return fmt.Errorf("must be an absolute http(s) URL like https://list.example.com, got %q", v)
	}
	return nil
}

// RenamedPrefix fails when a non-blank variable under oldPrefix is still set
// ([D-222]), since the setting it meant would silently not apply. removed lists
// the suffixes of settings dropped rather than renamed ([D-223]); the error
// says to delete those.
func RenamedPrefix(oldPrefix, newPrefix string, removed ...string) error {
	var renames, deletes []string
	for _, kv := range os.Environ() {
		name, value, _ := strings.Cut(kv, "=")
		suffix, ok := strings.CutPrefix(name, oldPrefix)
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		if slices.Contains(removed, suffix) {
			deletes = append(deletes, name)
		} else {
			renames = append(renames, name+" → "+newPrefix+suffix)
		}
	}
	if len(renames) == 0 && len(deletes) == 0 {
		return nil
	}
	slices.Sort(renames)
	slices.Sort(deletes)
	var parts []string
	if len(renames) > 0 {
		parts = append(parts, "rename these: "+strings.Join(renames, ", "))
	}
	if len(deletes) > 0 {
		parts = append(parts, "delete these, the settings are gone: "+strings.Join(deletes, ", "))
	}
	return fmt.Errorf("the %s variables were renamed to %s; %s",
		oldPrefix, newPrefix, strings.Join(parts, "; "))
}

// Unknown fails when a variable named with prefix is set but is none of
// known: a misspelt name is otherwise ignored, and the lockdown it meant to
// set stays off ([D-336]). One declared empty still boots, as in
// RenamedPrefix. where says where the settings are listed.
func Unknown(prefix string, known []string, where string) error {
	var unknown []string
	for _, kv := range os.Environ() {
		name, value, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, prefix) && strings.TrimSpace(value) != "" && !slices.Contains(known, name) {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	slices.Sort(unknown)
	return fmt.Errorf("%s: no setting of this server has that name, so it would do nothing; "+
		"correct the name or remove it (the settings are in %s)", strings.Join(unknown, ", "), where)
}
