import { expect, test, type Browser, type Locator, type Page } from './fixtures';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	addItemByTyping,
	addVirtualAuthenticator,
	chooseItemSort,
	createList,
	nicknameField,
	openListView,
	openShopView,
	registerAccount,
	showInviteLink
} from './helpers';

// Visual gate: walks every product screen in BOTH themes and asserts the
// computed colors against the token values in frontend/src/app.css. Light mode
// is the :root palette; dark mode is the `.dark` class mode-watcher puts on
// <html>, and every category-tinted surface must re-key with it.
//
// Element→token mapping notes (read from the markup):
//   - [data-slot="button"] default variant (auth CTA) is solid primary fill +
//     primary-foreground text. The shop view's done-row checkmark (.dc) is a
//     state: the text green, on no fill of its own ([D-281]).
//   - .listcard (home) and .tile (shop) use --surface-2, not --surface.
//   - The cat-chip and .cat-head backgrounds are color-mix() results over the
//     category token --c; asserted exactly against a probe element that
//     re-evaluates the same expression against the LIVE theme tokens.
//
// E2E_DIAG=1 also writes a full-page screenshot of every screen per theme and
// observed.json (the derived theme values and the cross-theme samples) to
// test-results/visual-gate/. Off by default: nothing asserts on them.
// The token LIST is the test's intent — WHICH tokens to check. Their VALUES are
// derived from frontend/src/app.css at collect time (the same parse-the-css
// approach design-tokens.test.ts uses) so a deliberate palette change edits one
// file, not two. A typo'd token name throws below rather than silently passing.
const TOKEN_MAP = {
	bg: '--background',
	fg: '--foreground',
	surface: '--surface',
	surface2: '--surface-2',
	primary: '--primary',
	primaryFg: '--primary-foreground',
	primaryText: '--primary-text',
	primarySoft: '--primary-soft'
} as const;

const APP_CSS = readFileSync(new URL('../../frontend/src/app.css', import.meta.url), 'utf8');

// Pull each theme's `--token: value;` declarations by slicing on the block
// selector (:root for light, .dark for dark — mode-watcher's class).
function themeTokens(which: 'light' | 'dark'): Record<string, string> {
	const start = which === 'light' ? APP_CSS.indexOf(':root {') : APP_CSS.indexOf('.dark {');
	if (start === -1)
		throw new Error(`visual-gate: no ${which === 'light' ? ':root' : '.dark'} block in app.css`);
	const end = APP_CSS.indexOf('}', start);
	const decls = APP_CSS.slice(start, end).match(/--[\w-]+:\s*[^;]+;/g) ?? [];
	const out: Record<string, string> = {};
	for (const d of decls) {
		const [k, v] = d.split(/:\s*/);
		out[k] = v.replace(/;\s*$/, '').trim();
	}
	return out;
}

// Resolve a token to a literal, following one level of var() indirection (none
// of the tokens above need it today, but a future palette that references
// another token must not silently change what is asserted).
function resolveToken(tokens: Record<string, string>, name: string): string {
	const raw = tokens[name];
	if (raw === undefined) throw new Error(`visual-gate: token ${name} missing from app.css`);
	const m = raw.match(/^var\((--[\w-]+)\)$/);
	if (m) {
		const inner = tokens[m[1]];
		if (inner === undefined)
			throw new Error(`visual-gate: token ${name} -> ${m[1]} missing from app.css`);
		return inner;
	}
	return raw;
}

const hexToRgb = (h: string): readonly [number, number, number] => {
	const n = h.replace('#', '');
	return [
		parseInt(n.slice(0, 2), 16),
		parseInt(n.slice(2, 4), 16),
		parseInt(n.slice(4, 6), 16)
	] as const;
};

function deriveTheme(
	which: 'light' | 'dark'
): Record<keyof typeof TOKEN_MAP, readonly [number, number, number]> {
	const tokens = themeTokens(which);
	const out = {} as Record<keyof typeof TOKEN_MAP, readonly [number, number, number]>;
	for (const [key, token] of Object.entries(TOKEN_MAP) as [keyof typeof TOKEN_MAP, string][]) {
		out[key] = hexToRgb(resolveToken(tokens, token));
	}
	return out;
}

const THEMES = {
	light: { scheme: 'light' as const, ...deriveTheme('light') },
	dark: { scheme: 'dark' as const, ...deriveTheme('dark') }
} as const;

type Theme = keyof typeof THEMES;
const DIAG = !!process.env.E2E_DIAG;
const SHOT_DIR = path.join('test-results', 'visual-gate');

interface Parsed {
	r: number;
	g: number;
	b: number;
	a: number;
	raw?: string;
}

/** Parses both legacy rgb()/rgba() and CSS Color 4 color(srgb …) serializations. */
function parseColor(c: string): Parsed {
	const m = c.match(
		/rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,\s/]\s*([\d.]+))?\s*\)/
	);
	if (m)
		return {
			r: Math.round(Number(m[1])),
			g: Math.round(Number(m[2])),
			b: Math.round(Number(m[3])),
			a: m[4] === undefined ? 1 : Number(m[4])
		};
	// Chromium reports computed color-mix() values in color(srgb …) form,
	// with 0-1 float components.
	const cm = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
	if (cm)
		return {
			r: Math.round(Number(cm[1]) * 255),
			g: Math.round(Number(cm[2]) * 255),
			b: Math.round(Number(cm[3]) * 255),
			a: cm[4] === undefined ? 1 : Number(cm[4])
		};
	return { r: -1, g: -1, b: -1, a: -1, raw: c };
}

/** Parsed computed color of `prop` on the first match of `locator`. */
async function rgb(
	page: Page,
	locator: Locator,
	prop: 'backgroundColor' | 'color' = 'backgroundColor'
): Promise<Parsed> {
	const raw = await locator.evaluate(
		(el, p) => getComputedStyle(el)[p as keyof CSSStyleDeclaration] as string,
		prop
	);
	return parseColor(raw);
}

function expectColor(
	actual: Parsed,
	expected: readonly [number, number, number],
	what: string,
	alpha = 1
): void {
	expect(actual, `${what} — got ${actual.raw ?? JSON.stringify(actual)}`).toEqual({
		r: expected[0],
		g: expected[1],
		b: expected[2],
		a: alpha
	});
}

/**
 * Asserts an element's background equals `color-mix(expr)` evaluated against
 * the LIVE theme tokens (probe element in the page). `token` is the element's
 * resolved --c value, so the probe mixes the same category color the element
 * does — proving the --cat-* tokens re-key with the theme.
 */
async function expectColorMix(
	page: Page,
	locator: Locator,
	token: string,
	percent: number,
	baseVar: string,
	what: string
): Promise<Parsed> {
	const expr = `color-mix(in srgb, ${token} ${percent}%, ${baseVar})`;
	const res = await locator.evaluate((el, e) => {
		const probe = document.createElement('div');
		probe.style.background = e;
		document.body.appendChild(probe);
		const expectedRaw = getComputedStyle(probe).backgroundColor;
		probe.remove();
		const parse = (c: string) => {
			const m = c.match(
				/rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,\s/]\s*([\d.]+))?\s*\)/
			);
			if (m)
				return {
					r: Math.round(Number(m[1])),
					g: Math.round(Number(m[2])),
					b: Math.round(Number(m[3])),
					a: m[4] === undefined ? 1 : Number(m[4])
				};
			const cm = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
			if (cm)
				return {
					r: Math.round(Number(cm[1]) * 255),
					g: Math.round(Number(cm[2]) * 255),
					b: Math.round(Number(cm[3]) * 255),
					a: cm[4] === undefined ? 1 : Number(cm[4])
				};
			return { r: -1, g: -1, b: -1, a: -1, raw: c };
		};
		return {
			actual: parse(getComputedStyle(el).backgroundColor),
			expected: parse(expectedRaw),
			expectedRaw
		};
	}, expr);
	expect(
		res.actual,
		`${what} — expected ${res.expectedRaw} (color-mix(${expr})), got ${JSON.stringify(res.actual)}`
	).toEqual(res.expected);
	return res.actual;
}

/** The element's resolved --c custom property (the category token). */
async function catToken(page: Page, locator: Locator): Promise<string> {
	const t = await locator.evaluate((el) => getComputedStyle(el).getPropertyValue('--c').trim());
	expect(t, 'element must carry a --c category token').toBeTruthy();
	return t;
}

/** Per-screen base checks: mode-watcher's `.dark` class + body background. */
async function assertThemeBase(page: Page, theme: Theme): Promise<void> {
	const isDark = theme === 'dark';
	expect(
		await page.evaluate(() => document.documentElement.classList.contains('dark')),
		`html.dark must be ${isDark} in ${theme} mode`
	).toBe(isDark);
	expectColor(await rgb(page, page.locator('body')), THEMES[theme].bg, `body bg (${theme})`);
}

// Cross-theme comparison data: category-tinted surfaces must re-key with the
// theme. Keyed `chip|cathead|settingschip` × `light|dark`, stored as r,g,b.
const observed: Record<string, string> = {};
function record(key: string, c: Parsed): void {
	observed[key] = `${c.r},${c.g},${c.b}`;
}

async function runTheme(theme: Theme, browser: Browser): Promise<void> {
	const t = THEMES[theme];
	// Diagnostic screenshot (E2E_DIAG=1 only).
	const shot = async (p: Page, screen: string) => {
		if (DIAG)
			await p.screenshot({ path: path.join(SHOT_DIR, `${screen}-${theme}.png`), fullPage: true });
	};

	// ---- (1) auth screen, logged out — separate context so the account flow
	// below starts clean, and the virtual authenticator story stays one-per-page.
	const authCtx = await browser.newContext();
	const authPage = await authCtx.newPage();
	await authPage.emulateMedia({ colorScheme: t.scheme });
	await addVirtualAuthenticator(authPage);
	await authPage.goto('/');
	const nicknameInput = nicknameField(authPage);
	await expect(nicknameInput).toBeVisible();
	await assertThemeBase(authPage, theme);
	await nicknameInput.fill('Anna');
	const primaryBtn = authPage.locator('[data-slot="button"]').first();
	await expect(primaryBtn).toBeEnabled();
	expectColor(
		await rgb(authPage, primaryBtn),
		t.primary,
		`auth primary btn bg (${theme}) — Button default variant is solid primary`
	);
	expectColor(
		await rgb(authPage, primaryBtn, 'color'),
		t.primaryFg,
		`auth primary btn text (${theme}) — primary-foreground on primary`
	);
	await shot(authPage, 'auth');
	await authCtx.close();

	// ---- authed flow: register, list, item, shop, settings, share ----
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.emulateMedia({ colorScheme: t.scheme });
	await registerAccount(page, theme === 'light' ? 'Anna' : 'Ben');

	// ---- (2) home with at least one list ----
	await expect(page.getByRole('button', { name: 'Neue Liste' }).first()).toBeVisible();
	await assertThemeBase(page, theme);
	const listUrl = await createList(page, 'Wochenshop');
	await page.getByRole('button', { name: 'Zurück' }).click();
	const card = page.locator('[data-slot="card"]').first();
	await expect(card).toBeVisible();
	await assertThemeBase(page, theme);
	expectColor(await rgb(page, card), t.surface2, `home list card bg (${theme})`);
	await shot(page, 'home');

	// ---- (3) list view with at least one item ----
	await page.goto(listUrl);
	// The shop view is the default tab (§9.1 "default in-store presentation"),
	// so switch to the list view where the add box lives.
	await openListView(page);
	await chooseItemSort(page, 'az');
	await expect(page.getByRole('combobox', { name: 'Artikel hinzufügen' })).toBeVisible();
	await addItemByTyping(page, 'Vollmilchschokolade');
	const row = page.locator('[data-testid="row"]').filter({ hasText: 'Vollmilchschokolade' });
	await expect(row).toBeVisible();
	await assertThemeBase(page, theme);
	expectColor(await rgb(page, row, 'color'), t.fg, `list row text (${theme})`);
	const chip = row.locator('[data-testid="cat-chip"]');
	await expect(chip).toBeVisible();
	const chipToken = await catToken(page, chip);
	const chipBg = await expectColorMix(
		page,
		chip,
		chipToken,
		14,
		// The icon plate ([D-181]): the raised surface in light, a light plate
		// under OpenMoji's black outlines in dark.
		'var(--icon-plate)',
		`cat-chip bg (${theme})`
	);
	record(`chip-${theme}`, chipBg);
	await shot(page, 'list');

	// ---- (4) shop view ----
	// Back to aisles: the A–Z picked for the chip above applies here too.
	await chooseItemSort(page, 'category');
	await openShopView(page);
	const tile = page.locator('[data-testid="tile"]').first();
	await expect(tile).toBeVisible();
	await assertThemeBase(page, theme);
	expectColor(await rgb(page, tile), t.surface2, `shop tile bg (${theme})`);
	const catHead = page.locator('.cat-head').first();
	await expect(catHead).toBeVisible();
	const headToken = await catToken(page, catHead);
	const catHeadBg = await expectColorMix(
		page,
		catHead,
		headToken,
		12,
		'var(--surface)',
		`cat-head bg (${theme})`
	);
	record(`cathead-${theme}`, catHeadBg);
	// Check an item off to expose the done row's green tick (.dc, [D-281]).
	await page.locator('[data-testid="tile"]', { hasText: 'Vollmilchschokolade' }).click();
	const dc = page.locator('[data-testid="done-row"] .dc');
	await expect(dc).toBeVisible();
	expectColor(await rgb(page, dc, 'color'), t.primaryText, `done-row check fg (${theme})`);
	await shot(page, 'shop');

	// ---- (5) settings ----
	await page.goto('/settings');
	const chips = page.getByTestId('settings-locale').locator('button');
	await expect(chips.first()).toBeVisible();
	await assertThemeBase(page, theme);
	const chipCount = await chips.count();
	for (let i = 0; i < chipCount; i++) {
		const bg = await rgb(page, chips.nth(i));
		expect(bg.a, `settings chip #${i} must be opaque (${theme})`).toBe(1);
	}
	const pressed = page.getByTestId('settings-locale').locator('button[aria-checked="true"]');
	record(`settingschip-${theme}`, await rgb(page, pressed));
	await shot(page, 'settings');

	// ---- (6) share sheet opened from the list ----
	await page.goto(listUrl);
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	await showInviteLink(page);
	await assertThemeBase(page, theme);
	await shot(page, 'share');

	await ctx.close();
}

test('visual gate: token fidelity in light and dark across all screens', async ({ browser }) => {
	test.setTimeout(240_000);
	if (DIAG) mkdirSync(SHOT_DIR, { recursive: true });

	await test.step('light theme', () => runTheme('light', browser));
	await test.step('dark theme', () => runTheme('dark', browser));

	// Cross-theme: every category-tinted surface must follow the theme (the
	// --cat-* re-key proof) — identical values would mean the dark palette
	// leaked light cat tokens.
	expect(observed['chip-light'], 'cat-chip bg must differ between themes').not.toEqual(
		observed['chip-dark']
	);
	expect(observed['cathead-light'], 'cat-head bg must differ between themes').not.toEqual(
		observed['cathead-dark']
	);
	expect(
		observed['settingschip-light'],
		'settings pressed chip bg must differ between themes'
	).not.toEqual(observed['settingschip-dark']);

	if (DIAG)
		writeFileSync(
			path.join(SHOT_DIR, 'observed.json'),
			JSON.stringify({ themes: THEMES, observed }, null, 2)
		);
});
