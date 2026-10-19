import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The ponyfill (barcode-detector) inlines zxing-wasm's JS glue at the version
// it depends on, and decode.ts hands it the .wasm binary from the app's own
// zxing-wasm. Glue and binary from different builds do not fail loudly: every
// detect() throws "memory access out of bounds", and the scanner reports a
// broken decoder on every browser — the ponyfill never uses a native
// BarcodeDetector — from v0.5.3 until [D-21]. This catches the
// version split at once; e2e/tests/scan-decode.spec.ts proves the shipped
// decoder actually decodes.
const pkg = (name: string) =>
	JSON.parse(
		readFileSync(new URL(`../../../node_modules/${name}/package.json`, import.meta.url), 'utf8')
	) as { version: string; dependencies?: Record<string, string> };

describe('the barcode decoder ships one zxing-wasm build ([D-21])', () => {
	it("pins zxing-wasm to the exact version barcode-detector's glue comes from", () => {
		const wanted = pkg('barcode-detector').dependencies?.['zxing-wasm'];
		expect(wanted, 'barcode-detector no longer depends on zxing-wasm').toBeDefined();
		expect(pkg('zxing-wasm').version).toBe(wanted);
	});
});
