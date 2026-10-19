package fieldcontract

import (
	"testing"
)

// [D-266] items.image_url is stamped by the server from the barcode: no op
// may carry it, so it is not writable.
func TestImageURLIsNotWritable(t *testing.T) {
	if Writable("items", "image_url") {
		t.Error("items.image_url is writable; the server stamps it from the barcode")
	}
}

// No server-stamped column is writable: the server owns them, and an op
// carries their optimistic values only in its unsent stamps ([D-26], [D-45]).
func TestServerStampedIsNotWritable(t *testing.T) {
	for _, field := range ServerStamped() {
		for _, collection := range []string{"items", "list_categories"} {
			if Writable(collection, field) {
				t.Errorf("%s.%s is server-stamped and writable", collection, field)
			}
		}
	}
}

// The push route refuses a value of another type (sync.typed): the two
// non-text fields say so, every other writable field is text.
func TestType(t *testing.T) {
	for _, c := range []struct{ collection, field, want string }{
		{"items", "checked", TypeBool},
		{"list_categories", "sort_order", TypeNumber},
		{"items", "name", TypeText},
		{"items", "modified_by", TypeText},
	} {
		if got := Type(c.collection, c.field); got != c.want {
			t.Errorf("Type(%s, %s) = %q, want %q", c.collection, c.field, got, c.want)
		}
	}
}
