// Package envflag parses the deployment's environment variables under one
// convention ([D-61]): unset or whitespace (how compose passes "not
// configured") keeps the default, and any value the app cannot use fails the
// boot with the variable named.
package envflag

import (
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
)

// Get returns env's value with surrounding whitespace removed.
func Get(env string) string {
	return strings.TrimSpace(os.Getenv(env))
}

// OnOff parses an on/off switch, case ignored; unset is def.
func OnOff(env string, def bool) (bool, error) {
	switch v := strings.ToLower(Get(env)); v {
	case "":
		return def, nil
	case "on":
		return true, nil
	case "off":
		return false, nil
	default:
		return false, fmt.Errorf("%s (%q) must be \"on\" or \"off\"", env, v)
	}
}

// PositiveInt parses a whole number of at least 1; unset returns def. unit
// names what the number counts, for the error message.
func PositiveInt(env string, def int, unit string) (int, error) {
	raw := Get(env)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%s (%q) must be a whole number >= 1 (%s)", env, raw, unit)
	}
	return n, nil
}

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
