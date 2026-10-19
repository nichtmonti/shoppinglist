package demo

import (
	"embed"
	"fmt"

	"github.com/pocketbase/pocketbase/core"

	"shoppinglist/internal/barcode"
)

// productPhotos are the example products' photos, one per barcode. They and
// the names below are Open Food Facts' (products/README.md).
//
//go:embed products/*.jpg
var productPhotos embed.FS

// exampleProducts are the scanned products in the client's example lists
// (frontend/src/lib/demo/start.ts). The demo stores them in its barcode cache
// at every boot, so the lists show their photos with no network ([D-234]).
var exampleProducts = []struct {
	ean string
	barcode.Product
}{
	{"8076800195057", barcode.Product{Name: "Spaghetti Nº5", NameDE: "Spaghetti No. 5", NameEN: "Spaghetti Nº5",
		CategorySlug: "pasta_rice", ImageURL: offPhoto("807/680/019/5057/front_en.3881")}},
	{"5411188115366", barcode.Product{Name: "Alpro Oat Original", NameDE: "Alpro Hafer Original", NameEN: "Alpro Oat Original",
		CategorySlug: "dairy_eggs", ImageURL: offPhoto("541/118/811/5366/front_en.270")}},
	{"4000417025005", barcode.Product{Name: "Ritter Sport Marzipan", NameDE: "Ritter Sport Marzipan", NameEN: "Ritter Sport Marzipan",
		CategorySlug: "snacks_sweets", ImageURL: offPhoto("400/041/702/5005/front_en.237")}},
	{"87157239", barcode.Product{Name: "Heinz Tomato Ketchup", NameDE: "Heinz Tomato Ketchup", NameEN: "Heinz Tomato Ketchup",
		CategorySlug: "pantry", ImageURL: offPhoto("000/008/715/7239/front_en.186")}},
	{"5449000000996", barcode.Product{Name: "Coca-Cola", NameDE: "Coca-Cola", NameEN: "Coca-Cola",
		CategorySlug: "beverages", ImageURL: offPhoto("544/900/000/0996/front_en.1129")}},
	{"4001686301555", barcode.Product{Name: "Haribo Goldbären", NameDE: "Haribo Goldbären", NameEN: "Haribo Goldbears",
		CategorySlug: "snacks_sweets", ImageURL: offPhoto("400/168/630/1555/front_zh.43")}},
	{"4029764001807", barcode.Product{Name: "Club-Mate", NameDE: "Club-Mate", NameEN: "Club-Mate",
		CategorySlug: "beverages", ImageURL: offPhoto("402/976/400/1807/front_en.227")}},
}

// offPhoto is the address Open Food Facts serves a product photo at, kept as a
// lookup keeps it.
func offPhoto(path string) string {
	return "https://images.openfoodfacts.org/images/products/" + path + ".400.jpg"
}

// storeExampleProducts puts every example product and its photo in the
// barcode cache, as a fresh lookup would.
func storeExampleProducts(app core.App) error {
	for _, p := range exampleProducts {
		photo, err := productPhotos.ReadFile("products/" + p.ean + ".jpg")
		if err != nil {
			return fmt.Errorf("example product %s: %w", p.ean, err)
		}
		p.Photo, p.PhotoExt = photo, "jpg"
		if err := barcode.Store(app, p.ean, p.Product); err != nil {
			return fmt.Errorf("example product %s: %w", p.ean, err)
		}
	}
	return nil
}
