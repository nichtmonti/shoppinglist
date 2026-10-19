package clienterrors_test

import (
	"net/http"
	"strings"
	"testing"

	"shoppinglist/internal/clienterrors"
	"shoppinglist/internal/testutil"
)

func TestReportBecomesOneLogLine(t *testing.T) {
	app, mux := testutil.NewMux(t, clienterrors.RegisterRoutes)
	_, token := testutil.CreateAccount(t, app, "Anna")
	logs := testutil.CaptureLog(t)

	body := `{"message":"TypeError: x is undefined","stack":"at a (<anonymous>)\nat b & c","route":"/list/[id]","path":"/list/abc","status":500,"version":"0.5.0","agent":"iPhone","context":"sw=controlled failed=/_app/x.js"}`
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/client-errors", body, testutil.AuthHeader(token))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	out := logs.String()
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("want exactly one log line, got %q", out)
	}
	for _, want := range []string{`client error`, `message="TypeError: x is undefined"`, `route="/list/[id]"`, `status=500`, `stack="at a (<anonymous>)\nat b & c"`, `context="sw=controlled failed=/_app/x.js"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log line lacks %s: %q", want, out)
		}
	}
	if strings.Contains(out, `account="-"`) {
		t.Errorf("an authenticated report should name its account: %q", out)
	}
}

func TestSignedOutReportIsAccepted(t *testing.T) {
	_, mux := testutil.NewMux(t, clienterrors.RegisterRoutes)
	logs := testutil.CaptureLog(t)

	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/client-errors", `{"message":"boom"}`, nil)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if !strings.Contains(logs.String(), `account="-"`) {
		t.Errorf("signed-out report should log account=\"-\": %q", logs.String())
	}
}

func TestFieldsAreTruncated(t *testing.T) {
	_, mux := testutil.NewMux(t, clienterrors.RegisterRoutes)
	logs := testutil.CaptureLog(t)

	long := strings.Repeat("ä", 1000) // 2000 bytes
	rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/client-errors", `{"message":"`+long+`"}`, nil)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if n := strings.Count(logs.String(), "ä"); n != 250 {
		t.Errorf("message kept %d runes, want 250 (500 bytes)", n)
	}
}

func TestOversizeAndMalformedBodiesAreRejected(t *testing.T) {
	_, mux := testutil.NewMux(t, clienterrors.RegisterRoutes)
	logs := testutil.CaptureLog(t)

	big := `{"stack":"` + strings.Repeat("x", 20<<10) + `"}`
	if rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/client-errors", big, nil); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize: status = %d, want 413", rec.Code)
	}
	if rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/client-errors", `not json`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("malformed: status = %d, want 400", rec.Code)
	}
	if logs.Len() != 0 {
		t.Errorf("a rejected report must log nothing: %q", logs.String())
	}
}

func TestReportsAreRateLimited(t *testing.T) {
	_, mux := testutil.NewMux(t, clienterrors.RegisterRoutes)
	testutil.CaptureLog(t)

	limited := false
	for range 20 {
		rec, _ := testutil.DoReq(mux, http.MethodPost, "/api/client-errors", `{"message":"m"}`, nil)
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("20 reports in a row were never rate-limited")
	}
}
