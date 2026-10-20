// The parts of the lint setup every config variant shares, split in TWO so
// the flat-config ordering can reproduce the exact precedence the original
// single config had:
//
//   js base → ts config → svelte config → prettier → overrides
//
// Order matters three ways:
// - ts.configs' `eslint-recommended` entry turns core no-unused-vars OFF for
//   .ts files — it must come AFTER js.configs.recommended (which turns it on
//   for all files) and AFTER the svelte config must NOT re-enable it.
// - ts.configs' base entry applies the ts parser to ALL files (no files key);
//   svelte.configs.recommended must come AFTER it so the svelte parser wins
//   for .svelte files.
// - prettier's rule-off entries must come after every rule config.
//
// The type-aware layer lives only in eslint.config.js (full, used by CI and
// the commit gate) — see eslint.syntactic.config.js for the fast iteration
// tier and why the split exists.
import prettier from 'eslint-config-prettier';
import js from '@eslint/js';
import betterTailwind from 'eslint-plugin-better-tailwindcss';
import boundaries from 'eslint-plugin-boundaries';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

// [D-146] The stock merges do not know the project theme.
const themeMergePaths = [
	{
		name: 'tailwind-merge',
		message: 'Use cn or tv from #lib/utils — they know the project theme ([D-146]).'
	},
	{
		name: 'tailwind-variants',
		importNames: ['tv', 'createTV', 'cn', 'cnMerge'],
		message: 'Use tv from #lib/utils — it merges with the project theme ([D-146]).'
	}
];

// [D-221] Tables only the sync engine writes: the view rows, their shadows and
// the outbox. A write anywhere else changes a row the server never hears of.
//
// [D-221] A tripwire over the call's shape, not a type check: it sees
// `db.items.put(…)` and `syncTable(c).put(…)`, and misses a write through an
// alias (`const t = db.items; t.put(…)`) or by name (`db.table('items')`).
// Neither form is used outside the engine; review is the guard against them.
const syncedTables = 'items|list_categories|server_items|server_list_categories|pending_ops';
const dexieWrite =
	'add|bulkAdd|put|bulkPut|update|bulkUpdate|delete|bulkDelete|clear|modify|upsert';
const syncedTableWrites = [
	{
		// `db.items.put(…)`, `db.items.where(…).equals(…).modify(…)`, …
		selector: `CallExpression[callee.property.name=/^(${dexieWrite})$/] > MemberExpression.callee MemberExpression[object.name='db'][property.name=/^(${syncedTables})$/]`,
		message:
			'Items and categories change only through the outbox writes in #lib/sync; the synced tables are the engine’s to write ([D-221]).'
	},
	{
		// `syncTable(c).put(…)`, `shadowTable(c).bulkDelete(…)`, …
		selector: `CallExpression[callee.property.name=/^(${dexieWrite})$/] > MemberExpression.callee CallExpression[callee.name=/^(syncTable|shadowTable)$/]`,
		message:
			'Items and categories change only through the outbox writes in #lib/sync; the synced tables are the engine’s to write ([D-221]).'
	}
];

// [D-291] A language switch re-renders strings in place, so a message resolved
// once into a constant of a component's script stays in the old language.
// `$derived` follows it; a `$state` seeded from one is a shown message, like a
// toast, and keeps the language it appeared in.
const onceTranslated = [
	{
		selector:
			"VariableDeclaration CallExpression[callee.name='t']:not(:function *, CallExpression[callee.name=/^\\$(derived|state)$/] *)",
		message:
			'A message resolved once does not follow a language switch: wrap it in $derived, or call t() in the markup ([D-291]).'
	}
];

// [D-314] The design tokens, held where a class is written: in markup, in
// cn()/tv() and in the class-string constants. Each entry refuses Tailwind's
// stock answer to a question app.css has answered, and names the answer.
// Variants are part of the class (`dark:text-xs`), hence `(?:^|:)`.
const colourUtility =
	'(?:^|:)(?:text|bg|border(?:-[xytbse])?|ring|outline|fill|stroke|from|via|to|divide|decoration|caret)-';

const tokenClasses = [
	{
		pattern: '(?:^|:)text-(?:xs|lg|xl|[2-9]xl|\\[\\d.+\\])$',
		message:
			'Text sizes come from the ramp in app.css: micro, note, meta, qty, sm, name, base, tile, title, hero ([D-314]).'
	},
	{
		pattern: '(?:^|:)text-(?:hero|title)(?:/\\S+)?$',
		message: 'A hero or screen title is a role: type-hero or type-title ([D-314]).'
	},
	{
		pattern: '(?:^|:)font-(?:thin|extralight|light|medium|semibold|extrabold|black|\\[.+\\])$',
		message: 'Four weights: font-normal, font-book, font-demi, font-bold ([D-314]).'
	},
	{
		pattern: '(?:^|:)(?:tracking-\\S+|uppercase)$',
		message:
			'Letter-spacing and capitals come with a type role in app.css: type-hero, type-title, type-heading, type-section, type-caption ([D-314]).'
	},
	{
		pattern:
			'(?:^|:)rounded(?:-[a-z]{1,2})?(?:-(?:xs|sm|md|lg|xl|[2-4]xl|tile|panel|sheet|\\[\\d.+\\]))?$',
		message:
			'Three radii: rounded-chip inside a row or a control, -control for what is pressed or typed into, -card for a surface or a picture; or -full ([D-316]).'
	},
	{
		pattern: '(?:^|:)focus(?:-visible|-within)?:(?:ring|border|shadow)(?:-\\S*)?$',
		message:
			'Focus is the one outline in app.css ([D-315]); a row that spans the column insets it with focus-visible:-outline-offset-2.'
	},
	{
		pattern:
			'(?:^|:)-?(?:p[xytbselr]?|m[xytbselr]?|gap(?:-[xy])?|space-[xy])-(?:\\d+\\.(?:25|75)|\\[\\d*[13579]px\\])$',
		message:
			'Spacing sits on a 2px grid: a whole or half step (gap-2.5, not gap-2.75), or `px` for a 1px nudge ([D-318]).'
	},
	{
		pattern: '^(?:m-0|p-0|border-0|bg-transparent|text-inherit|font-inherit|list-none)$',
		message:
			"Tailwind's preflight already resets margins, padding, borders and list style, and gives buttons and fields the page's font, colour and a clear ground. To change a part's default, change the part ([D-320])."
	},
	{
		pattern: '^(?:hover|active):(?:bg-(?:primary-soft|surface-2)|border-primary-line)$',
		message:
			'A pressable row or card presses grey: `press-row`, or hover:bg-tint / active:bg-tint-strong. Soft green means chosen ([D-281], [D-321]).'
	},
	{
		pattern: '(?:^|:)-?z-(?:[4-9]|[1-9]\\d+|\\[.+\\])$',
		message:
			'A page layer is named: z-(--layer-sticky), z-(--layer-bar), z-(--layer-modal). Layers inside a component are 1-3, sealed with `isolate` ([D-317]).'
	},
	{
		pattern: '(?:^|:)shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|\\[(?!inset).+\\]))?$',
		message: 'Elevation: shadow-pop (rises downward) or shadow-sheet (upward) ([D-314]).'
	},
	{
		pattern:
			'(?:^|:)(?:text|bg|border(?:-[xytbse])?|ring|outline|fill|stroke|from|via|to|divide|decoration|accent|caret)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d+(?:/\\d+)?|\\[(?:#|rgb|hsl|oklch|oklab|color-mix).+\\])$',
		message:
			'Colours are tokens (app.css: foreground, muted-foreground, primary, surface, primary-soft, …), never a palette step or a literal ([D-314]).'
	},
	{
		// shadcn's names, which were aliases of the app's ([D-316]); a part
		// copied in from shadcn-svelte arrives with them.
		pattern: `${colourUtility}(?!muted-foreground$)(?:card|popover|secondary|muted|accent|input|ring|destructive|sidebar|chart)(?:-[\\w-]+)?$`,
		message:
			'One name per colour ([D-316]): surface (card, popover), surface-2 (muted), primary-soft (accent, secondary), primary-text (ring), line-strong (input), danger (destructive).'
	},
	{
		pattern: `${colourUtility}(?!(?:micro|note|meta|qty|sm|name|base|tile|title|hero)/)[a-z][\\w-]*/\\S+$`,
		message:
			'No opacity on a colour ([D-316]): a grey fill is bg-tint (a hover, a resting field) or bg-tint-strong (a press, disabled, a grey chip); a tone has its -soft and -line.'
	},
	{
		pattern: '(?:^|:)(?:divide-\\S+|last:border(?:-[xytbse])?-0)$',
		message:
			'Rows are separated by RuledRows (or the ruled-rows utility), with the line from the content column ([D-326]).'
	}
];

// [D-333] Outside ui/, a size, a space or a timing is a step of the scale or a
// token in app.css: an arbitrary value is how one screen's 26px chip and
// another's 40px button got in. A ui/ part may hold one, as the place a look
// is decided. Variants (`data-[…]:`, `has-[…]:`, `[&_svg]:`) and grid or flex
// templates are not values and stay allowed.
// [D-333] A look one part owns, refused everywhere else: the part is the one
// place it is spelled.
const ownedLooks = [
	{
		pattern: '^cat-head$',
		message:
			'A group header band is AisleHeader (a settings group passes sticky={false}) ([D-333]).'
	},
	{
		pattern: '(?:^|:)underline$',
		message: 'A link out of the app in a line of text is TextLink ([D-333]).'
	}
];

const arbitraryValue = {
	pattern:
		'(?:^|:)-?(?:[pm][xytbse]?|gap(?:-[xy])?|size|[wh]|(?:min|max)-[wh]|inset(?:-[xy])?|top|bottom|start|end|left|right|text|leading|tracking|duration|delay|scale|translate-[xy]|rotate|grayscale|opacity|rounded(?:-[a-z]{1,2})?|z|basis)-\\[.+\\]$',
	message:
		'No arbitrary value outside ui/ ([D-333]): use a step of the scale (size-6.5, gap-2) or a token from app.css; a new look goes into a ui/ part or app.css.'
};

// [D-314] An icon's size is a class on the scale (size-3.5 … size-5.5), or the
// Button's. A lucide `size={18}` inside a Button lost to the Button's own svg
// size, so the number in the markup was not what the screen showed.
// [D-325] A grey line that explains is a Hint, not a paragraph painted by hand.
const greyLine = {
	selector:
		"SvelteElement[name.name='p'] > SvelteStartTag > SvelteAttribute[key.name='class'] > SvelteLiteral[value=/\\btext-muted-foreground\\b/]",
	message:
		'A grey line is a Hint (size meta or sm), or OfflineHint under a control that needs the server ([D-325]).'
};

// [D-332] A chosen tile is PickerTile's look, the aisle, emoji and colour
// pickers alike; a radio drawn by hand is how the colour swatches kept a
// black ring of their own.
const pickerTile = {
	selector:
		"SvelteElement[kind='component'][name.object.name='RadioGroup'][name.property.name='Item']",
	message:
		'A picker tile is PickerTile from #lib/components/ui/picker-tile: it carries the chosen mark, a green edge and tick ([D-319], [D-332]).'
};

// [D-333] Lines a part already draws, written by hand.
const handDrawn = [
	{
		// A group's footnote holds parts, each with its own look.
		selector: "SvelteSnippetBlock[id.name='footnote'] SvelteElement[name.name='p']",
		message:
			'A footnote holds a Hint, an OfflineHint or an ErrorText, not a bare paragraph ([D-333]).'
	},
	{
		selector:
			"SvelteElement[name.name='p'] > SvelteStartTag > SvelteAttribute[key.name='class'] > SvelteLiteral[value=/\\btext-danger\\b/]",
		message: 'A red line is ErrorText: it is announced as it appears ([D-325], [D-333]).'
	},
	{
		selector:
			"SvelteElement[name.name='RuledRows'] > SvelteStartTag > SvelteAttribute[key.name='inset'] > SvelteLiteral[value='0.375rem']",
		message: 'Rows in a sheet are RuledRows flush, with SettingsRow flush in it ([D-333]).'
	}
];

// [D-333] An inline style sets a custom property from data (categoryStyle, a
// `--name: …`) that a class reads; a style written out is a class nobody can
// find. ui/ parts are exempt.
const rawStyle = [
	{
		selector: "SvelteAttribute[key.name='style'] > SvelteLiteral:first-child[value=/^\\s*[^-\\s]/]",
		message: 'An inline style only sets a custom property (`--x: …`) that a class reads ([D-333]).'
	},
	{
		selector:
			"SvelteAttribute[key.name='style'] TemplateLiteral > TemplateElement:first-child[value.raw=/^\\s*[^-\\s]/]",
		message: 'An inline style only sets a custom property (`--x: …`) that a class reads ([D-333]).'
	},
	{
		selector: 'SvelteStyleDirective[key.name.name=/^[^-]/]',
		message:
			'A style directive only sets a custom property (style:--x) that a class reads ([D-333]).'
	}
];

const iconSizeProp = {
	selector: "SvelteAttribute[key.name='size'] > SvelteMustacheTag > Literal[value>=4]",
	message:
		'Size an icon with a class from the scale (size-3.5, -4, -4.5, -5, -5.5), or leave it to the Button ([D-314]).'
};

// The app's layers and who may import whom ([D-220], [D-221]), one
// table for eslint-plugin-boundaries. It sees static, re-exported and dynamic
// imports (`import('…')`) and tells a type import from a value import; the
// TypeScript resolver takes `#lib/…`, relative paths and `.svelte` files to
// the file they name. A dependency no policy allows is refused.
//
// The layers are folders, the deepest match wins; the lib root is `pure`.
const layerElements = [
	...'paraglide test-kit sync actions state auth demo scan i18n components'
		.split(' ')
		.map((name) => [name, `src/lib/${name}`]),
	['pure', 'src/lib'],
	['routes', 'src/routes'],
	['behaviour', 'src/integration/behaviour'],
	['integration', 'src/integration'],
	['service-worker', 'src/service-worker'],
	['app', 'src']
].map(([type, pattern]) => ({ type, pattern, partialMatch: false }));

// Files with a role of their own: the Dexie store and the SDK client (in the
// lib root, but not pure), the behaviour specs' one adapter, the looser
// matching helpers ([D-44]) and the rest of the path that decides the
// server's duplicate merge (§8.3 [D-29]). `source` is every file, so a
// `noneOf` matches one without a role.
const layerFiles = Object.entries({
	test: '**/*.test.ts',
	svelte: '**/*.svelte',
	store: 'src/lib/db.ts',
	client: 'src/lib/pb.ts',
	world: 'src/integration/behaviour/world.ts',
	'loose-matching': 'src/lib/{classify,fold-umlauts,typeahead}.ts',
	'merge-path': 'src/lib/{dedup,item-name,normalize}.ts',
	'reports-errors': 'src/lib/client-errors.ts',
	wipe: 'src/lib/auth/account-data.ts',
	source: 'src/**'
}).map(([category, pattern]) => ({ category, pattern }));

/** A selector for one layer: a folder, or a file role. */
function layer(name) {
	if (name === '*') return { element: { type: '*' } };
	if (['store', 'client', 'world'].includes(name)) return { file: { categories: name } };
	const without = { pure: ['store', 'client'], behaviour: ['world'] }[name];
	return { element: { type: name }, ...(without && { file: { categories: { noneOf: without } } }) };
}
const layers = (names) => names.split(' ').map(layer);

// What each layer may import, values and types. The store's Dexie upgrades
// run engine code; pb.ts announces a restored session ([D-109]); the root
// layout imports app.css (`app`).
const allowed = {
	paraglide: 'paraglide',
	pure: 'pure i18n paraglide',
	i18n: 'i18n pure paraglide',
	store: 'sync pure',
	client: 'auth pure',
	sync: 'sync store client auth pure',
	auth: 'auth store client pure i18n',
	actions: 'actions sync store client auth pure i18n',
	state: 'state sync store client auth demo pure i18n',
	scan: 'scan actions state store client auth pure i18n',
	demo: 'demo components scan state actions store client auth pure i18n',
	components: 'components scan demo state actions sync auth pure i18n paraglide',
	routes: 'routes app components demo state actions sync client auth pure i18n',
	'service-worker': 'service-worker pure',
	app: 'pure',
	behaviour: 'behaviour world pure',
	world: '*',
	integration: '*',
	'test-kit': '*'
};
const behaviourOnlyWorld =
	'Behaviour specs talk to the engine only through world.ts, so they survive a different engine.';
const scanButton = { element: { type: 'scan' }, file: { categories: 'svelte' } };

const layerPolicies = [
	...Object.entries(allowed).map(([from, to]) => ({
		from: layer(from),
		allow: { to: layers(to) }
	})),
	// Outside the engine, types are anyone's but a component's. The error
	// reporter posts through pb, the sign-out wipe resets the live caches
	// ([D-145]), and the scan button is a component beside its pipeline.
	{
		from: { element: { type: '!sync' } },
		allow: { to: layers('store sync state actions pure i18n'), dependency: { kind: 'type' } }
	},
	{ from: { file: { categories: 'reports-errors' } }, allow: { to: layer('client') } },
	{ from: { file: { categories: 'wipe' } }, allow: { to: layer('state') } },
	{ from: scanButton, allow: { to: layer('components') } },
	// [D-220] Outside the engine, only its index.ts; the store's upgrades and
	// the test harnesses reach further.
	{
		from: [
			{ element: { type: '!{sync,pure,test-kit,integration,behaviour}' } },
			...layers('pure behaviour')
		],
		disallow: { to: { element: { type: 'sync', fileInternalPath: '!index.ts' } } },
		message:
			'Import the sync engine from #lib/sync, its public surface; its modules are internal ([D-220]).'
	},
	// [D-221] Components read through #lib/state/data and write through
	// #lib/actions: from the store they take only types, and they reach the
	// server through #lib/actions and the account through #lib/auth.
	{
		from: [layer('components'), scanButton],
		disallow: { to: layers('store client'), dependency: { kind: 'value' } },
		message:
			'Components read through #lib/state/data and write through #lib/actions; import only types from #lib/db, and reach the server through #lib/actions and #lib/auth ([D-221]).'
	},
	{
		from: layer('routes'),
		disallow: { to: layer('store'), dependency: { kind: 'value' } },
		message:
			'Routes read through #lib/state/data and write through #lib/actions; import only types from #lib/db ([D-221]).'
	},
	// [D-221] The duplicate merge matches through normalizeName only.
	{
		from: [...layers('sync actions'), { file: { categories: 'merge-path' } }],
		disallow: { to: { file: { categories: 'loose-matching' } } },
		message:
			'The duplicate merge matches through normalizeName only; the looser matching stays off the outbox path ([D-44], [D-221]).'
	},
	// Test code never ships: the frontend half of backend/deps_arch_test.go.
	{
		from: { element: { type: '!{test-kit,integration,behaviour}' } },
		disallow: { to: layer('test-kit') },
		message: 'Test code never ships: only tests import from #lib/test-kit.'
	},
	// Tests may reach anything, an engine internal included…
	{ from: { file: { categories: 'test' } }, allow: { to: layer('*') } },
	// …except the behaviour specs, which describe outcomes and must survive a
	// different engine: world.ts is their one adapter.
	{
		from: layer('behaviour'),
		disallow: { to: layers('sync store client actions integration test-kit') },
		message: behaviourOnlyWorld
	}
];

/** Rules that must come BEFORE the ts config (core js base). */
export function sharedBase() {
	return [js.configs.recommended];
}

/** Everything that must come AFTER the ts config. */
export function sharedRest() {
	return [
		svelte.configs.recommended,
		prettier,
		svelte.configs.prettier,
		{
			languageOptions: {
				globals: { ...globals.browser, ...globals.node }
			},
			plugins: { boundaries },
			settings: {
				'boundaries/root-path': import.meta.dirname,
				// The app's code; the configs and build scripts beside it are no layer.
				'boundaries/include': ['src/**'],
				'boundaries/elements': layerElements,
				'boundaries/files': layerFiles,
				'import/resolver': { typescript: { project: `${import.meta.dirname}/tsconfig.json` } }
			},
			rules: {
				// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
				// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
				'no-undef': 'off',

				// Off: an async function with no await is normal for test fakes and for
				// injectable transports whose signature must be Promise-returning.
				'@typescript-eslint/require-await': 'off',

				// [D-146] The stock merges do not know the project theme: they read
				// `text-micro` as a colour and silently drop classes at runtime. Every
				// merge goes through #lib/utils (cn, tv), which is taught
				// it — and a re-pulled shadcn component would otherwise bring the
				// stock import straight back.
				'no-restricted-imports': ['error', { paths: themeMergePaths }],

				'boundaries/dependencies': [
					'error',
					{ default: 'disallow', checkInternals: true, policies: layerPolicies }
				]
			}
		},
		{
			// The one place the stock merges are configured.
			files: ['src/lib/utils.ts'],
			rules: { 'no-restricted-imports': 'off' }
		},
		{
			// The browser has these only in a secure context, and the demo also
			// runs on plain http:// at a LAN address, where every call throws ([D-335]).
			// Tests run in node, and the digest tests check against crypto.subtle.
			files: ['src/**'],
			ignores: ['**/*.test.ts'],
			rules: {
				'no-restricted-properties': [
					'error',
					{ object: 'crypto', property: 'randomUUID', message: "Use v4() from 'uuid'." },
					{
						object: 'crypto',
						property: 'subtle',
						message: 'Use @noble/hashes, as src/lib/sync/digest.ts does.'
					}
				]
			}
		},
		{
			// [D-221] Outside the engine the synced tables are read, never
			// written. The engine, the store's own module (schema), the sign-out
			// wipe (auth/account-data.ts) and the fixtures that seed it are exempt.
			ignores: [
				'src/lib/sync/**',
				'src/lib/db.ts',
				'src/lib/auth/account-data.ts',
				'src/lib/test-kit/db.ts',
				'src/integration/**',
				'**/*.test.ts'
			],
			rules: { 'no-restricted-syntax': ['error', ...syncedTableWrites] }
		},
		{
			// [D-291] Components' scripts resolve messages where they render. This
			// block replaces the rule for them, so it restates the [D-221] guard.
			files: ['src/**/*.svelte'],
			rules: {
				'no-restricted-syntax': [
					'error',
					...syncedTableWrites,
					...onceTranslated,
					iconSizeProp,
					greyLine,
					pickerTile,
					...handDrawn,
					...rawStyle
				]
			}
		},
		{
			// The behaviour specs mock nothing: a mocked engine module would test
			// the implementation, which only world.ts may know ([D-306]).
			files: ['src/integration/behaviour/**'],
			ignores: ['src/integration/behaviour/world.ts'],
			rules: {
				'no-restricted-syntax': [
					'error',
					{
						selector:
							"CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock|importActual|importMock)$/]",
						message: behaviourOnlyWorld
					}
				]
			}
		},
		{
			// [D-314] The design tokens, where classes are written. The plugin reads
			// class attributes, cn()/tv() and the class-string constants named
			// below; the canonical rule keeps one spelling per class
			// (`w-(--qty-w)`, not `w-[var(--qty-w)]`), so a search finds them all.
			files: ['src/**/*.svelte', 'src/**/*.ts'],
			ignores: ['**/*.test.ts', 'src/paraglide/**'],
			plugins: { 'better-tailwindcss': betterTailwind },
			settings: {
				'better-tailwindcss': {
					entryPoint: 'src/app.css',
					variables: [
						['^(?:classNames?|classes|styles?)$', [{ match: 'strings' }]],
						[
							'^(?:[a-z]\\w*(?:Class|Cls|Surface|Base|Tone)|[A-Z_]+_CLASS)$',
							[{ match: 'strings' }, { match: 'objectValues' }]
						]
					]
				}
			},
			rules: {
				'better-tailwindcss/no-restricted-classes': ['error', { restrict: tokenClasses }],
				'better-tailwindcss/enforce-canonical-classes': 'error',
				'better-tailwindcss/no-duplicate-classes': 'error'
			}
		},
		{
			// [D-333] The same, plus no arbitrary value and no look a part owns.
			// Exempt: the ui/ parts and the parts that own a look;
			// the emoji's 1em box; the safe-area pad at the screen's foot; and,
			// the quantity field's own cap while it is typed into, and the
			// list card's 40px ⋮ and its clip.
			files: ['src/**/*.svelte', 'src/**/*.ts'],
			ignores: [
				'**/*.test.ts',
				'src/paraglide/**',
				'src/routes/dev/**',
				'src/lib/components/ui/**',
				'src/lib/components/common/Emoji.svelte',
				'src/lib/components/common/StickyFoot.svelte',
				'src/lib/components/common/QuantityControl.svelte',
				'src/lib/components/home/ListCard.svelte',
				// the parts that own a look below
				'src/lib/components/common/AisleHeader.svelte',
				'src/lib/components/common/TextLink.svelte'
			],
			rules: {
				'better-tailwindcss/no-restricted-classes': [
					'error',
					{ restrict: [...tokenClasses, arbitraryValue, ...ownedLooks] }
				]
			}
		},
		{
			// [D-311] A button is a `Button`: its variants are the button family
			// ([D-284]), and a hand-styled <button> is how the soft-green, dashed
			// and faint-edged ones got in. The exceptions are surfaces that press,
			// not buttons: rows, tiles, status lines and their parts.
			files: ['src/**/*.svelte'],
			ignores: [
				'src/lib/components/ui/**',
				// rows and their parts
				'src/lib/components/list/ListRow.svelte',
				'src/lib/components/list/ListSwitcher.svelte',
				'src/lib/components/settings/SettingsRow.svelte',
				'src/lib/components/history/PreviousItem.svelte',
				'src/lib/components/common/PrevItemsLink.svelte',
				'src/lib/components/common/QuantityControl.svelte',
				'src/lib/components/shop/DoneItems.svelte',
				// the head of a section that folds away, a caption that presses
				'src/lib/components/common/SectionToggle.svelte',
				// tiles and pictures
				'src/lib/components/shop/ShopTile.svelte',
				'src/lib/components/common/ProductPhoto.svelte',
				// status lines and the sync chip
				'src/lib/components/banner/SyncLine.svelte',
				'src/lib/components/banner/SyncBanner.svelte',
				// the add field's scrim, which only closes the dropdown
				'src/lib/components/add/AddBar.svelte',
				// the gallery's own toolbar (dev only): raw inputs and a select,
				// the browser's own, outside the app's look
				'src/routes/dev/gallery/LiveGallery.svelte'
			],
			rules: {
				'svelte/no-restricted-html-elements': [
					'error',
					{
						elements: ['button'],
						message:
							'Use Button from #lib/components/ui/button: its variants are the button family ([D-284], [D-311]). A pressable row or tile goes on the list in eslint.shared.config.js with its reason.'
					},
					{
						elements: ['input', 'textarea', 'select'],
						message:
							'Use Input, Textarea, NativeSelect or Checkbox from #lib/components/ui: they carry the app’s field ([D-314]).'
					}
				]
			}
		},
		{
			// TS inside .svelte <script> blocks goes through the ts parser; the
			// svelte parser handles the template. extraFileExtensions lets the
			// parser treat the file as TS.
			files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
			languageOptions: {
				parserOptions: {
					extraFileExtensions: ['.svelte'],
					parser: ts.parser
				}
			}
		},
		{
			// Vendored shadcn-svelte components ship bare English (dialog close
			// labels, empty-state text). The app routes every string through
			// Paraglide `t()`, so a literal that reaches the DOM here is an
			// untranslatable pocket — and one that returns silently every time a
			// component is re-pulled from upstream. [D-54] Finding #3.
			//
			// Syntactic, so it runs in the fast tier too. Style blocks and the
			// `class`/`data-*` attribute soup are excluded: only text nodes and the
			// attributes that carry an accessible name are user-facing.
			files: ['src/lib/components/ui/**/*.svelte'],
			rules: {
				// This block replaces the rule for these files, so it restates the
				// [D-221] write guard and the [D-291] one.
				'no-restricted-syntax': [
					'error',
					...syncedTableWrites,
					...onceTranslated,
					iconSizeProp,
					{
						selector:
							'SvelteElement:not([name=/^(style|script)$/]) > SvelteText[value=/[A-Za-z]{2}/]',
						message:
							'Bare text in a vendored ui/ component is untranslatable — route it through t() from #lib/i18n ([D-54] Finding #3).'
					},
					{
						selector:
							'SvelteAttribute[key.name=/^(aria-label|aria-description|aria-roledescription|title|placeholder|alt)$/] > SvelteLiteral[value=/[A-Za-z]{2}/]',
						message:
							'Bare accessible-name literal in a vendored ui/ component is untranslatable — route it through t() from #lib/i18n ([D-54] Finding #3).'
					}
				]
			}
		}
	];
}
