// Package normalize implements the shared item-name normalization
// (docs/internals/design.md §9, [D-44]): trim → NFKC → lowercase → collapse
// whitespace. Its output decides the push route's [D-29] duplicate-name merge.
package normalize

import (
	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"
)

var wsRe = regexp.MustCompile(`\s+`)

// Name returns the canonical form of an item name.
func Name(s string) string {
	s = strings.TrimSpace(s)
	s = norm.NFKC.String(s)
	s = strings.ToLower(s)
	s = wsRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}
