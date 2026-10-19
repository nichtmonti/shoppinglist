package normalize

import (
	"encoding/json"
	"os"
	"testing"
)

type vector struct {
	In, Out, Note string
}

func TestName(t *testing.T) {
	data, err := os.ReadFile("../../seed/normalization-vectors.json")
	if err != nil {
		t.Fatalf("failed to read vectors file: %v", err)
	}

	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("failed to decode vectors: %v", err)
	}

	for i, v := range vectors {
		got := Name(v.In)
		if got != v.Out {
			t.Errorf("vector %d (%s): Name(%q)=%q want %q", i, v.Note, v.In, got, v.Out)
		}
	}
}
