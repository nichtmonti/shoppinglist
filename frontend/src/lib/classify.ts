// §9 head-noun auto-categorisation for names the dictionary does not know
// ([D-48]): grocery compounds are head-final (Vollmilch·SCHOKOLADE, chocolate
// MILK), so names are scored by longest common SUFFIX, which must cover a whole
// known name. Not fuzzy matching ([D-16]): no edit distance, no stemming beyond
// a fixed list of inflection tails. The rules follow the app's language
// (`Grammar`); the names it matches are pooled across languages. It only
// fills a `category_key` that would otherwise be null.
import type { Item, ItemDictionary, ListCategory } from './db';
import type { Locale } from './i18n';
import { othersCategory, visibleCategories } from './categories';
import { normalizeName } from './normalize';
import { foldUmlauts } from './fold-umlauts';
import { byUpdatedDesc } from './sorting';

/** Shortest head noun accepted from inside a compound: "eis" must not file "Reis". */
const MIN_HEAD = 4;

/** …and from a word of its own, where it is unambiguously the head ("deli ham", "Bio Tee"). */
const MIN_WORD = 3;

/**
 * …and a head not at a word boundary must be MORE than a third of the compound
 * ("lauch" in "brunnenschlauch" is exactly 5/15). Integer arithmetic
 * (`k * 3 > len`), so that exact third is reliably rejected. Both constants are
 * pinned by classify-vectors.json.
 */
const MIN_HEAD_SHARE = 3;

/** Never strip an inflection down to a stub — "Eis" must not become "e". */
const MIN_STEM = 3;

/**
 * How one language writes the names on a shopping list: the rules the matcher
 * applies, never the vocabulary, which stays pooled across languages (a
 * German list holds "Chicken Wings"). Every rule assumes the head noun comes
 * last, as the matcher does: a head-first language (Spanish "leche de soja")
 * needs a matcher that reads from the front, not just a grammar of its own.
 */
export interface Grammar {
	/** Plural and case tails stripped from a typed name ("Salzkartoffeln"
	 *  reaches "kartoffel"), tried in this order, which decides ties. */
	tails: readonly string[];
	/** …and the tails a singular lacks, added to a last word of MIN_STEM or
	 *  more ("Erdbeere" reaches "erdbeeren"; "Ei" is not "Eis"). Only a whole
	 *  word may match this way. Each is also one of `tails`, where its turn
	 *  comes. */
	plurals: readonly string[];
	/** Words that start a detail after the product ("Müsli ohne Zucker",
	 *  "Kaffee in Pads"): the words before them decide. */
	details: ReadonlySet<string>;
	/** Whether a word files the name under the frozen aisle ("TK Himbeeren"). */
	frozen: (word: string) => boolean;
}

/** Never "er" among the plurals: "Mozzarella light" is no lighter. */
const GERMAN: Grammar = {
	tails: ['n', 'en', 'e', 's', 'es', 'er'],
	plurals: ['n', 'en', 'e', 's'],
	details: new Set(['mit', 'ohne', 'fuer', 'in', 'im', 'aus', 'von', 'vom', 'am']),
	frozen: (word) => word === 'tk' || word === 'tiefgekuehlt' || word.startsWith('tiefkuehl')
};

const ENGLISH: Grammar = {
	tails: ['s', 'es'],
	plurals: ['s'],
	details: new Set(['with', 'without', 'for', 'in']),
	frozen: (word) => word === 'frozen'
};

/** Each language's own grammar. */
export const GRAMMARS: Record<Locale, Grammar> = { de: GERMAN, en: ENGLISH };

/**
 * The grammars a name is read by under each app language. A household writes
 * in more than one ("frozen peas" on a German list), so German and English
 * apply together, German first: its tails' order decides ties.
 */
const ACTIVE: Record<Locale, readonly Grammar[]> = {
	de: [GERMAN, ENGLISH],
	en: [GERMAN, ENGLISH]
};

/** One grammar applying every rule of `grammars`. */
function combine(grammars: readonly Grammar[]): Grammar {
	const unique = (lists: (readonly string[])[]) => [...new Set(lists.flat())];
	return {
		tails: unique(grammars.map((g) => g.tails)),
		plurals: unique(grammars.map((g) => g.plurals)),
		details: new Set(grammars.flatMap((g) => [...g.details])),
		frozen: (word) => grammars.some((g) => g.frozen(word))
	};
}

const COMBINED = Object.fromEntries(
	Object.entries(ACTIVE).map(([locale, grammars]) => [locale, combine(grammars)])
) as Record<Locale, Grammar>;

/** The rules a name is read by under app language `locale`. */
export function grammarFor(locale: Locale): Grammar {
	return COMBINED[locale];
}

/**
 * The matching form of a name: folds umlauts, ß, diacritics and punctuation on
 * top of `normalizeName`, which must not ([D-44], [D-221]). Nothing it produces
 * is stored, synced or compared against a server-side key.
 */
export function foldForMatch(name: string): string {
	return (
		// Before NFD: composed ä must become "ae", not decompose to a + ¨ → "a".
		foldUmlauts(normalizeName(name))
			// Everything else diacritical just loses the mark: "crème" → "creme".
			.normalize('NFD')
			.replace(/\p{M}+/gu, '')
			// Hyphens, dots, %, ® … — "Bio-Tomaten" and "BioTomaten" must match.
			.replace(/[^\p{L}\p{N} ]+/gu, '')
			.replace(/ +/g, ' ')
			.trim()
	);
}

/** One name we already know the aisle of, resolved to this list's category row. */
export interface Candidate {
	/** `foldForMatch(name)`. */
	folded: string;
	/** `folded` without its spaces, what the suffix match compares. */
	joined: string;
	/** A live `list_categories.id` on this list — never null, never Others. */
	categoryKey: string;
	/** That category's seed slug; null for one the list made itself. */
	slug: string | null;
	/** True when this came from the list's own items rather than the seed dictionary. */
	learned: boolean;
	/** Dictionary popularity; 0 for learned names (they rank by `learned` first). */
	weight: number;
}

/** What `classify` matches against, and the rules it matches by. */
export interface Corpus {
	candidates: Candidate[];
	grammar: Grammar;
}

/**
 * The corpus: this list's own categorised items first (they win ties and are
 * the only source for custom categories), then the dictionary mirror in every
 * locale. Both skip Others: a candidate pointing at the fallback bucket carries
 * no signal and would only outrank a real match. `locale` is the app's
 * language, which picks the grammar.
 */
export function buildCorpus(
	dictionary: ItemDictionary[],
	items: Item[],
	categories: ListCategory[],
	locale: Locale
): Corpus {
	const visible = visibleCategories(categories);
	const othersId = othersCategory(categories)?.id;
	const slugById = new Map(visible.map((c) => [c.id, c.slug ?? null]));

	// Most recently touched row wins a duplicate name, as in `latestRowByKey`.
	const byRecency = [...items].sort(byUpdatedDesc);
	const learned: Candidate[] = [];
	const seen = new Set<string>();
	for (const item of byRecency) {
		if (item.deleted_at !== null) continue;
		const key = item.category_key;
		if (!key || key === othersId || !slugById.has(key)) continue;
		const folded = foldForMatch(item.name);
		if (!folded || seen.has(folded)) continue;
		seen.add(folded);
		learned.push({
			folded,
			joined: joinWords(folded),
			categoryKey: key,
			slug: slugById.get(key) ?? null,
			learned: true,
			weight: 0
		});
	}

	return {
		candidates: [...learned, ...seededCandidates(dictionary, categories)],
		grammar: grammarFor(locale)
	};
}

/**
 * The dictionary half of the corpus, memoized on the (dictionary, categories)
 * identity so an item edit does not refold it. The store arrays are replaced,
 * never mutated.
 */
let seededMemo: {
	dictionary: ItemDictionary[];
	categories: ListCategory[];
	seeded: Candidate[];
} | null = null;

function seededCandidates(dictionary: ItemDictionary[], categories: ListCategory[]): Candidate[] {
	if (seededMemo?.dictionary === dictionary && seededMemo.categories === categories) {
		return seededMemo.seeded;
	}
	const othersId = othersCategory(categories)?.id;
	const idBySlug = new Map<string, string>();
	for (const c of visibleCategories(categories)) if (c.slug) idBySlug.set(c.slug, c.id);

	const seeded: Candidate[] = [];
	for (const entry of dictionary) {
		if (!entry.default_category) continue;
		const categoryKey = idBySlug.get(entry.default_category);
		if (!categoryKey || categoryKey === othersId) continue;
		for (const names of Object.values(entry.names_i18n ?? {})) {
			for (const name of names ?? []) {
				const folded = foldForMatch(name);
				if (folded)
					seeded.push({
						folded,
						joined: joinWords(folded),
						categoryKey,
						slug: entry.default_category,
						learned: false,
						weight: entry.popularity ?? 0
					});
			}
		}
	}
	seededMemo = { dictionary, categories, seeded };
	return seeded;
}

/**
 * A folded name with its words run together: "WC-Reiniger", "WC Reiniger" and
 * "WCReiniger" are one name, however the seed or the typist joined its parts.
 */
function joinWords(folded: string): string {
	return folded.replaceAll(' ', '');
}

/** How many trailing characters `a` and `b` share. */
function commonSuffixLength(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
	return i;
}

interface Score {
	/** 1 = the whole query IS a known name; 0 = it was found as a compound's head. */
	whole: number;
	/** Length of the matched head. */
	k: number;
	/** Inflection characters stripped to get there — fewer is better. */
	penalty: number;
	learned: boolean;
	weight: number;
}

function outranks(a: Score, b: Score): boolean {
	if (a.whole !== b.whole) return a.whole > b.whole;
	if (a.k !== b.k) return a.k > b.k;
	if (a.penalty !== b.penalty) return a.penalty < b.penalty;
	if (a.learned !== b.learned) return a.learned;
	return a.weight > b.weight;
}

/**
 * The aisle a name most likely belongs to (a `list_categories.id`), or null,
 * meaning Others. The shared suffix must cover a candidate's whole name. Only
 * when nothing matches are trailing words dropped, one at a time: a
 * description after the noun hides it from the suffix ("Hummus pikant",
 * "Milch 1,5 %", [D-48]). A name marked as frozen goes to the frozen aisle
 * ("TK Himbeeren"), and a fruit or vegetable after a product is its flavour
 * ("Chips Paprika").
 */
export function classify(name: string, corpus: Corpus): string | null {
	const words = foldForMatch(name).split(' ');
	const { grammar } = corpus;
	// A name marked as frozen is, unless the dictionary or the list knows it
	// whole: "Tiefkühlbeutel" are freezer bags, and a name a member filed
	// stays where they filed it.
	if (words.some(grammar.frozen) && !matchHead(words.join(' '), corpus)?.whole) {
		const frozen = corpus.candidates.find((c) => c.slug === FROZEN);
		if (frozen) return frozen.categoryKey;
	}
	// "Müsli ohne Zucker", "Tee mit Zitrone": the words before a detail decide.
	const detail = words.findIndex((w, i) => i > 0 && grammar.details.has(w));
	const head = detail > 0 ? classifyWords(words.slice(0, detail), corpus) : null;
	return (head ?? classifyWords(words, corpus))?.candidate.categoryKey ?? null;
}

/** The aisle the grammar's frozen marker files under. */
const FROZEN = 'frozen';

/** Fruit, vegetables and herbs: after a product they name its flavour. */
const FLAVOUR = 'produce';

function classifyWords(words: string[], corpus: Corpus): Hit | null {
	for (let n = words.length; n > 0; n--) {
		const hit = matchHead(words.slice(0, n).join(' '), corpus);
		if (!hit) continue;
		// "Joghurt Erdbeere", "Spülmittel Zitrone": the product before the
		// flavour decides, unless it is produce too ("Salat Gurke"). So it
		// does before a word only read as a plural ("Avocado reif" is no tyre).
		if (n > 1 && hit.inLastWord && (hit.candidate.slug === FLAVOUR || hit.guessed)) {
			// …never one only read as a plural itself ("sweet" is no sweets).
			const product = classifyWords(words.slice(0, n - 1), corpus);
			if (product && !product.guessed) {
				if (hit.guessed || product.candidate.slug !== FLAVOUR) return product;
			}
		}
		return hit;
	}
	return null;
}

/**
 * The query with each inflection tail stripped ("Salzkartoffeln" reaches
 * "kartoffel") and with a plural tail added ("Erdbeere" reaches "Erdbeeren",
 * "Erdbeer" too), each costing its length. `added` is how much of the query
 * the typist did not type.
 */
function inflected(
	folded: string,
	grammar: Grammar
): { query: string; penalty: number; added: number }[] {
	const out = [{ query: folded, penalty: 0, added: 0 }];
	const lastWord = folded.slice(folded.lastIndexOf(' ') + 1);
	for (const tail of grammar.tails) {
		const stem = folded.slice(0, folded.length - tail.length);
		if (folded.endsWith(tail) && stem.length >= MIN_STEM) {
			out.push({ query: stem, penalty: tail.length, added: 0 });
		}
		if (grammar.plurals.includes(tail) && lastWord.length >= MIN_STEM) {
			out.push({ query: folded + tail, penalty: tail.length, added: tail.length });
		}
	}
	return out;
}

/** A match; `inLastWord` when it lies within the query's last word,
 *  `guessed` when it needed a plural tail, `whole` when it is the whole name. */
interface Hit {
	candidate: Candidate;
	inLastWord: boolean;
	guessed: boolean;
	whole: boolean;
}

/** The suffix match over one folded query. */
function matchHead(folded: string, corpus: Corpus): Hit | null {
	if (!folded) return null;

	let best: Score | null = null;
	let bestHit: Hit | null = null;

	for (const { query, penalty, added } of inflected(folded, corpus.grammar)) {
		const joined = joinWords(query);
		const lastWordLength = query.length - query.lastIndexOf(' ') - 1;
		// Where each word after the first starts in `joined`.
		const wordStarts = new Set<number>();
		let at = 0;
		for (const word of query.split(' ')) {
			if (at > 0) wordStarts.add(at);
			at += word.length;
		}

		for (const candidate of corpus.candidates) {
			const v = candidate.joined;
			if (v.length > joined.length) continue;
			if (commonSuffixLength(joined, v) !== v.length) continue;

			const whole = v.length === joined.length;
			if (!whole) {
				// A match starting a word is unambiguously the head ("2 liter
				// milch"); inside a compound it has to carry real weight, and
				// may not lean on a tail nobody typed.
				if (wordStarts.has(joined.length - v.length)) {
					if (v.length < MIN_WORD) continue;
				} else if (
					added ||
					v.length < MIN_HEAD ||
					v.length * MIN_HEAD_SHARE <= joined.length ||
					// Inside a word it may not reach past a space the typist
					// put there: "Wasser Eis" is no "reis".
					v.length > lastWordLength
				) {
					continue;
				}
			}

			const score: Score = {
				whole: whole ? 1 : 0,
				k: v.length - added,
				penalty,
				learned: candidate.learned,
				weight: candidate.weight
			};
			if (best === null || outranks(score, best)) {
				best = score;
				bestHit = {
					candidate,
					inLastWord: v.length <= lastWordLength,
					guessed: added > 0,
					whole
				};
			}
		}
	}

	return bestHit;
}
