import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, setMeta } from '../db';
import {
	checkAndMirrorReference,
	type SeedVersionTransport,
	type ReferenceFetcher
} from './mirror';
import type { CategoryTemplate, ItemDictionary } from '../db';
import { pb } from '../pb';

function tpl(slug: string): CategoryTemplate {
	return {
		slug,
		name_i18n: { en: slug },
		icon: 'icon',
		color: 'color',
		sort_order: 0,
		retired: false
	};
}

function dict(id: string): ItemDictionary {
	return {
		id,
		names_i18n: { en: [id] },
		default_category: null,
		popularity: 0
	};
}

describe('checkAndMirrorReference', () => {
	beforeEach(async () => {
		await db.category_templates.clear();
		await db.item_dictionary.clear();
		await db.meta.clear();
	});

	it('server version === meta → no re-mirror, returns false, reference fetcher NOT called', async () => {
		await setMeta('seed_version', '1');
		// In-sync means a version match AND a populated corpus: an empty table
		// trips the self-heal instead (covered by its own test below).
		await db.item_dictionary.bulkPut([dict('existing')]);
		const versionTransport: SeedVersionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher: ReferenceFetcher = vi.fn();
		const result = await checkAndMirrorReference({ versionTransport, referenceFetcher });
		expect(result).toBe(false);
		expect(versionTransport).toHaveBeenCalledTimes(1);
		expect(referenceFetcher).not.toHaveBeenCalled();
	});

	it('server version differs → re-mirror, returns true', async () => {
		await setMeta('seed_version', '1');
		const versionTransport: SeedVersionTransport = vi.fn().mockResolvedValue('2');
		const referenceFetcher: ReferenceFetcher = vi.fn().mockResolvedValue({
			templates: [tpl('a'), tpl('b')],
			dictionary: [dict('x')]
		});
		const result = await checkAndMirrorReference({ versionTransport, referenceFetcher });
		expect(result).toBe(true);
		expect(versionTransport).toHaveBeenCalledTimes(1);
		expect(referenceFetcher).toHaveBeenCalledTimes(1);
		const dbTemplates = await db.category_templates.toArray();
		const dbDictionary = await db.item_dictionary.toArray();
		expect(dbTemplates).toHaveLength(2);
		expect(dbDictionary).toHaveLength(1);
		const metaVersion = await db.meta.get('seed_version');
		expect(metaVersion?.value).toBe('2');
	});

	it('re-mirror REPLACES the old reference (clear then put)', async () => {
		// Seed 5 old templates
		const oldTemplates = [tpl('old1'), tpl('old2'), tpl('old3'), tpl('old4'), tpl('old5')];
		await db.category_templates.bulkPut(oldTemplates);
		expect(await db.category_templates.count()).toBe(5);

		const versionTransport: SeedVersionTransport = vi.fn().mockResolvedValue('2');
		const referenceFetcher: ReferenceFetcher = vi.fn().mockResolvedValue({
			templates: [tpl('new1'), tpl('new2')],
			dictionary: [dict('new1')]
		});
		const result = await checkAndMirrorReference({ versionTransport, referenceFetcher });
		expect(result).toBe(true);
		const dbTemplates = await db.category_templates.toArray();
		expect(dbTemplates).toHaveLength(2);
		expect(dbTemplates.map((t) => t.slug)).toEqual(['new1', 'new2']);
		expect(await db.item_dictionary.toArray()).toHaveLength(1);
	});

	it('empty dictionary fetch → throws, old reference untouched, version NOT stamped', async () => {
		await setMeta('seed_version', '1');
		await db.item_dictionary.bulkPut([dict('old'), dict('older')]);
		await db.category_templates.bulkPut([tpl('old')]);
		const versionTransport: SeedVersionTransport = vi.fn().mockResolvedValue('2');
		const referenceFetcher: ReferenceFetcher = vi.fn().mockResolvedValue({
			templates: [tpl('a')],
			dictionary: []
		});
		await expect(checkAndMirrorReference({ versionTransport, referenceFetcher })).rejects.toThrow(
			'empty dictionary'
		);
		expect(await db.item_dictionary.count()).toBe(2);
		expect(await db.category_templates.count()).toBe(1);
		expect((await db.meta.get('seed_version'))?.value).toBe('1');
	});

	it('matching version but empty local dictionary → re-mirrors (self-heal)', async () => {
		await setMeta('seed_version', '1');
		const versionTransport: SeedVersionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher: ReferenceFetcher = vi.fn().mockResolvedValue({
			templates: [tpl('a')],
			dictionary: [dict('x')]
		});
		const result = await checkAndMirrorReference({ versionTransport, referenceFetcher });
		expect(result).toBe(true);
		expect(referenceFetcher).toHaveBeenCalledTimes(1);
		expect(await db.item_dictionary.count()).toBe(1);
	});

	it('unset meta.seed_version (first run) → mirrors', async () => {
		const versionTransport: SeedVersionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher: ReferenceFetcher = vi.fn().mockResolvedValue({
			templates: [tpl('a')],
			dictionary: [dict('x')]
		});
		const result = await checkAndMirrorReference({ versionTransport, referenceFetcher });
		expect(result).toBe(true);
		const metaVersion = await db.meta.get('seed_version');
		expect(metaVersion?.value).toBe('1');
		expect(await db.category_templates.count()).toBe(1);
		expect(await db.item_dictionary.count()).toBe(1);
	});
});

// The mirror check runs inside the sync cycle, and cycles and drains serialize
// behind one another — a request that never settles would stall sync until a
// reload, so the default transports must time out like the cycle's others.
describe('checkAndMirrorReference default transports', () => {
	beforeEach(async () => {
		await db.item_dictionary.clear();
		await db.meta.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('the seed-version and reference reads carry a timeout signal', async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ version: '7' }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		const getFullList = vi.fn(async (options?: { signal?: AbortSignal }) => {
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			return [{ id: 'd1', slug: 's', names_i18n: {}, popularity: 0 }];
		});
		vi.spyOn(pb, 'collection').mockReturnValue({ getFullList } as never);

		await checkAndMirrorReference();

		const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(getFullList).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});
});
