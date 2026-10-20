package barcode

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/testutil"
)

const downloadEAN = "4006381333931"

// shortWait makes a lookup give up on its photo after a moment, for the
// tests whose photo host is slower than that.
func shortWait(t *testing.T) {
	t.Helper()
	old := photoWait
	photoWait = 20 * time.Millisecond
	t.Cleanup(func() { photoWait = old })
}

func cacheRow(t *testing.T, app core.App, ean string) *core.Record {
	t.Helper()
	rec, err := app.FindFirstRecordByFilter("barcode_cache", "barcode = {:barcode}", dbx.Params{"barcode": ean})
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

// eventually polls cond for up to five seconds: the background download
// settles on its own goroutine.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("%s did not happen within five seconds", what)
}

// The case that started it: Open Food Facts' photo host slower than the
// lookup waits. The lookup answers without the photo, the item made from that
// answer has none, and the download, still going, then hands the photo to the
// item.
func TestASlowPhotoReachesTheItemScannedBeforeItArrived(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	Register(app)
	shortWait(t)
	up.photoDelay = 300 * time.Millisecond

	res, body := lookup(t, mux, token, downloadEAN)
	if res.Code != http.StatusOK || body.Name == "" || body.ImageURL != "" {
		t.Fatalf("lookup = %d %+v, want the product without its photo yet", res.Code, body)
	}
	list := testutil.CreateList(t, app, "Drogerie")
	item := testutil.CreateItem(t, app, list, "Sonnencreme", func(r *core.Record) { r.Set("barcode", downloadEAN) })
	if item.GetString("image_url") != "" {
		t.Fatalf("item made before the photo arrived has image_url %q", item.GetString("image_url"))
	}

	eventually(t, "the item's photo", func() bool {
		got, err := app.FindRecordById("items", item.Id)
		return err == nil && strings.HasPrefix(got.GetString("image_url"), photoPathPrefix)
	})
	if got, want := mustItem(t, app, item.Id).GetString("image_url"), issuedPhotoPath(cacheRow(t, app, downloadEAN)); got != want {
		t.Errorf("item image_url = %q, want the stored photo %q", got, want)
	}
}

// A photo that answers 404 will answer 404 again: its URL is cleared, so
// neither the retry job nor a later lookup asks for it again.
func TestAPhotoGoneForGoodIsNotTriedAgain(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	up.photoCode = http.StatusNotFound

	if _, body := lookup(t, mux, token, downloadEAN); body.Name == "" || body.ImageURL != "" {
		t.Fatalf("lookup = %+v, want the product without a photo", body)
	}
	if url := cacheRow(t, app, downloadEAN).GetString("image_url"); url != "" {
		t.Fatalf("cache image_url = %q after a 404, want it cleared", url)
	}
	if err := RetryPhotos(app); err != nil {
		t.Fatal(err)
	}
	rec := cacheRow(t, app, downloadEAN)
	rec.Set("fetched_at", time.Now().Add(-negativeCacheTTL-time.Minute))
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
	lookup(t, mux, token, downloadEAN)
	if n := up.photoCount(); n != 1 {
		t.Errorf("photo host asked %d times, want once", n)
	}
}

// A photo that failed for a reason that can pass is the retry job's: once the
// host answers, the photo is stored and the item scanned meanwhile gets it.
func TestTheRetryJobStoresAPhotoThatFailedForAWhile(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	Register(app)
	up.photoCode = http.StatusServiceUnavailable

	lookup(t, mux, token, downloadEAN)
	list := testutil.CreateList(t, app, "Drogerie")
	item := testutil.CreateItem(t, app, list, "Sonnencreme", func(r *core.Record) { r.Set("barcode", downloadEAN) })

	up.photoCode = http.StatusOK
	if err := RetryPhotos(app); err != nil {
		t.Fatal(err)
	}
	path := issuedPhotoPath(cacheRow(t, app, downloadEAN))
	if path == "" {
		t.Fatal("the retry job stored no photo")
	}
	if got := mustItem(t, app, item.Id).GetString("image_url"); got != path {
		t.Errorf("item image_url = %q, want %q", got, path)
	}
}

// The retry job asks only for photos looked up within photoRetryWindow.
func TestTheRetryJobStopsAfterItsWindow(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	up.photoCode = http.StatusServiceUnavailable
	lookup(t, mux, token, downloadEAN)

	rec := cacheRow(t, app, downloadEAN)
	rec.Set("fetched_at", time.Now().Add(-photoRetryWindow-time.Hour))
	if err := app.SaveNoValidate(rec); err != nil {
		t.Fatal(err)
	}
	up.photoCode = http.StatusOK
	if err := RetryPhotos(app); err != nil {
		t.Fatal(err)
	}
	if n := up.photoCount(); n != 1 {
		t.Errorf("photo host asked %d times, want once: the window is over", n)
	}
}

// An item that shows a photo keeps it when another one is stored for its
// barcode: its URL is never swapped ([D-21]).
func TestAStoredPhotoLeavesAnItemsOwnPhoto(t *testing.T) {
	newUpstream(t)
	app, _, _ := barcodeMux(t)
	list := testutil.CreateList(t, app, "Drogerie")
	item := testutil.CreateItem(t, app, list, "Sonnencreme", func(r *core.Record) {
		r.Set("barcode", downloadEAN)
		r.Set("image_url", photoPathPrefix+"0123456789abcdef0123456789abcdef")
	})
	if err := fillItems(app, downloadEAN, photoPathPrefix+"fedcba9876543210fedcba9876543210"); err != nil {
		t.Fatal(err)
	}
	if got := mustItem(t, app, item.Id).GetString("image_url"); got != photoPathPrefix+"0123456789abcdef0123456789abcdef" {
		t.Errorf("item image_url = %q, want its own photo kept", got)
	}
}

// A second lookup while the photo is still coming waits for that download
// instead of starting another.
func TestALookupDuringADownloadSharesIt(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	shortWait(t)
	up.photoDelay = 300 * time.Millisecond

	lookup(t, mux, token, downloadEAN)
	expireCache(t, app, downloadEAN)
	lookup(t, mux, token, downloadEAN)
	eventually(t, "the photo", func() bool { return issuedPhotoPath(cacheRow(t, app, downloadEAN)) != "" })
	if n := up.photoCount(); n != 1 {
		t.Errorf("photo host asked %d times, want once", n)
	}
}

// Store puts a product and its photo in the cache as a lookup would, so the
// lookup answers from it without asking upstream: the demo's examples.
func TestStoreAnswersWithoutTheNetwork(t *testing.T) {
	up := newUpstream(t)
	app, mux, token := barcodeMux(t)
	if err := Store(app, downloadEAN, Product{
		Name: "Spaghetti Nº5", NameDE: "Spaghetti No. 5", NameEN: "Spaghetti Nº5",
		CategorySlug: "pasta_rice", ImageURL: "https://images.openfoodfacts.org/x.jpg",
		Photo: onePixelPNG, PhotoExt: "png",
	}); err != nil {
		t.Fatal(err)
	}
	res, body := lookup(t, mux, token, downloadEAN)
	if res.Code != http.StatusOK || body.NameDE != "Spaghetti No. 5" || !strings.HasPrefix(body.ImageURL, photoPathPrefix) {
		t.Fatalf("lookup = %d %+v, want the stored product with its photo", res.Code, body)
	}
	if hits := up.siteCounts(); len(hits) != 0 || up.photoCount() != 0 {
		t.Errorf("upstream asked: sites %v, photos %d; want nothing", hits, up.photoCount())
	}
}

func mustItem(t *testing.T, app core.App, id string) *core.Record {
	t.Helper()
	rec, err := app.FindRecordById("items", id)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

// With every slot taken, a download is not started and settles at once; the
// retry job is left to fetch it.
func TestADownloadWithoutASlotStartsNothing(t *testing.T) {
	up := newUpstream(t)
	app := testutil.NewApp(t)
	for range maxPhotoDownloads {
		downloadSlots <- struct{}{}
	}
	t.Cleanup(func() {
		for range maxPhotoDownloads {
			<-downloadSlots
		}
	})

	select {
	case <-downloadPhoto(app, downloadEAN, up.server.URL+"/photo"):
	case <-time.After(5 * time.Second):
		t.Fatal("a download without a slot did not settle at once")
	}
	if n := up.photoCount(); n != 0 {
		t.Errorf("photo host asked %d times without a slot, want never", n)
	}
}
