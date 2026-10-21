import { db, getMeta, setMeta } from '../db';
import type { CategoryTemplate, ItemDictionary } from '../db';
import { pb } from '../pb';
import { apiJson } from './http';

// Both default transports carry a timeout, like every other request the cycle makes: the
// mirror check runs inside the cycle, and cycles and drains serialize behind one another
// (cycle.ts cycleTail) — a request that never settles would stall sync until a reload.
const SEED_VERSION_TIMEOUT_MS = 10_000;
const REFERENCE_TIMEOUT_MS = 30_000;

// Fetch the server seed version ({version: string}) via GET /api/seed-version (auth required).
export type SeedVersionTransport = () => Promise<string>;
async function defaultSeedVersionTransport(): Promise<string> {
	const data = (await apiJson('/api/seed-version', {
		label: 'seed-version',
		timeoutMs: SEED_VERSION_TIMEOUT_MS
	})) as { version: string };
	return data.version;
}

// Fetch the full global reference (category_templates + item_dictionary) via PB SDK reads
// (§11: authenticated read). Returns the clean-shape rows.
export type ReferenceFetcher = () => Promise<{
	templates: CategoryTemplate[];
	dictionary: ItemDictionary[];
}>;
async function defaultReferenceFetcher(): Promise<{
	templates: CategoryTemplate[];
	dictionary: ItemDictionary[];
}> {
	// requestKey null: the SDK's auto-cancellation would otherwise put its own
	// signal in place of this one, and the timeout would never fire.
	const options = { signal: AbortSignal.timeout(REFERENCE_TIMEOUT_MS), requestKey: null };
	const [templates, dictionary] = await Promise.all([
		pb.collection('category_templates').getFullList(options),
		pb.collection('item_dictionary').getFullList(options)
	]);
	// PB JSONField (name_i18n / names_i18n) serializes as the parsed object; the rows already
	// match the Dexie schema. Coerce default_category nullability defensively.
	return {
		templates: templates.map((r) => ({
			slug: r.slug,
			name_i18n: (r as unknown as { name_i18n: Record<string, string> }).name_i18n,
			icon: r.icon,
			color: r.color,
			sort_order: r.sort_order,
			retired: r.retired === true
		})),
		dictionary: dictionary.map((r) => ({
			id: r.id,
			names_i18n: (r as unknown as { names_i18n: Record<string, string[]> }).names_i18n,
			default_category: (r as unknown as { default_category?: string }).default_category ?? null,
			popularity: r.popularity
		}))
	};
}

export interface MirrorOptions {
	versionTransport?: SeedVersionTransport;
	referenceFetcher?: ReferenceFetcher;
}

// If the server's seed_version differs from the mirrored meta.seed_version, re-pull the global
// reference collections and update meta. Returns true if a re-mirror happened, false if in sync.
export async function checkAndMirrorReference(opts: MirrorOptions = {}): Promise<boolean> {
	const versionTransport = opts.versionTransport ?? defaultSeedVersionTransport;
	const referenceFetcher = opts.referenceFetcher ?? defaultReferenceFetcher;
	const server = await versionTransport();
	const local = await getMeta('seed_version');
	// Self-heal: a version match normally means "already mirrored", but an empty
	// dictionary table is not that state — it means a previous mirror emptied it
	// (or a fresh device never got one). Re-mirror instead of trusting the stamp.
	if (local === server && (await db.item_dictionary.count()) > 0) return false;

	const { templates, dictionary } = await referenceFetcher();
	// An empty dictionary is not a valid reference: the server's seed always
	// ships hundreds of rows, so zero rows means a broken fetch (wrong scope,
	// empty collection, proxy glitch). Treat it as a failure — never clear the
	// local corpus and never stamp the version, so the next cycle retries.
	if (dictionary.length === 0) throw new Error('reference fetch returned an empty dictionary');
	await db.transaction('rw', db.category_templates, db.item_dictionary, async () => {
		await db.category_templates.clear();
		await db.item_dictionary.clear();
		await db.category_templates.bulkPut(templates);
		await db.item_dictionary.bulkPut(dictionary);
	});
	await setMeta('seed_version', server);
	return true;
}
