// An amount written with an item's name ("500 g Butter", "Zwiebeln (3)"), read
// off as its free-text quantity ([D-20]). One rule for every place text comes
// in: the text import reads a line with `splitQuantity` ([D-254]), the add
// field reads what was typed with `readTypedAmount` ([D-285]).

// An amount: a whole or decimal number, a fraction, or a vulgar fraction.
const NUMBER = String.raw`(?:\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔])?|\d+\/\d+|[½¼¾⅓⅔])`;
// The units a German or English list writes after an amount. Case-insensitive,
// a whole word, with an optional abbreviation dot.
const UNIT = String.raw`(?:kg|kilo(?:s|gramm)?|g|gr|gramm|grams?|mg|l|ltr|liter|liters|litre|litres|ml|cl|dl|stk|stck|stück|st|pck|pkg|pkt|packung(?:en)?|päckchen|paket(?:e)?|pack(?:s)?|dose(?:n)?|fl|flasche(?:n)?|glas|gläser|becher|bund|btl|beutel|tüte(?:n)?|netz|kiste(?:n)?|kasten|rolle(?:n)?|tafel(?:n)?|kopf|köpfe|würfel|zehe(?:n)?|schale(?:n)?|scheibe(?:n)?|el|tl|prise(?:n)?|pc|pcs|piece(?:s)?|can(?:s)?|bottle(?:s)?|jar(?:s)?|bag(?:s)?|box(?:es)?|cartons?|heads?|bunch(?:es)?|loaf|loaves|dozen|tbsp|tsp|cup(?:s)?|oz|lb(?:s)?|pounds?|pints?|quarts?|qt|gallons?|x|×)`;
const LEADING_AMOUNT = new RegExp(
	String.raw`^(${NUMBER})(?:\s*(${UNIT})(?![\p{L}\d])\.?)?\s+(.+)$`,
	'iu'
);
// A unit with nothing after it: "500 g" is an amount still waiting for its
// name, not 500 of an item called "g".
const UNIT_ALONE = new RegExp(String.raw`^${UNIT}\.?$`, 'iu');
const BRACKETED_AMOUNT = new RegExp(
	String.raw`^(.*\S)\s*\((${NUMBER}(?:\s*${UNIT}(?![\p{L}\d])\.?)?)\)$`,
	'iu'
);
const TRAILING_AMOUNT = new RegExp(
	String.raw`^(.*\S)\s+(${NUMBER})(?:\s*(${UNIT})(?![\p{L}\d])\.?)?$`,
	'iu'
);

export interface Amounted {
	name: string;
	/** As written ("1 kg", "3"); '' for none. */
	quantity: string;
}

/** Spaces of every kind collapse to one; invisible ones go. */
export function cleanSpaces(line: string): string {
	return line
		.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
		.replace(/\s+/gu, ' ')
		.trim();
}

/** A bare number is an amount only up to three digits ("4711 Echt Kölnisch
 *  Wasser" keeps its number); with a unit any number goes. */
function amountOk(amount: string, unit: string | undefined): boolean {
	return unit !== undefined || !/\d{4}/u.test(amount);
}

/**
 * The text import's rule ([D-254]): the amount a line starts with, or ends
 * with in brackets, and the name without it. A leading number must be
 * followed by a space ("7up" stays a name). A name that would be left empty,
 * or start with a percent sign ("1,5 % Milch"), keeps its number.
 */
export function splitQuantity(line: string): Amounted {
	const lead = LEADING_AMOUNT.exec(line);
	if (lead) {
		const [, amount, unit, rest] = lead;
		if (
			amountOk(amount, unit) &&
			!/^[%‰]/u.test(rest) &&
			!(unit === undefined && UNIT_ALONE.test(rest))
		) {
			return {
				name: rest.trim(),
				quantity: cleanSpaces(line.slice(0, line.length - rest.length))
			};
		}
	}
	const bracketed = BRACKETED_AMOUNT.exec(line);
	if (bracketed) return { name: bracketed[1].trim(), quantity: cleanSpaces(bracketed[2]) };
	return { name: line, quantity: '' };
}

/**
 * What the add field reads ([D-285]): the import's rule, plus an amount at
 * the end after a space ("Milch 2 l", "Eier 10"), since someone typing sees
 * the suggestion first and the amount comes to mind after it. `isKnownName`
 * gets the whole text: a name the dictionary or the list has as written
 * ("Tempo 100") is not split. The add field shows the split before anything
 * is added, so a misreading is visible.
 */
export function readTypedAmount(text: string, isKnownName: (name: string) => boolean): Amounted {
	const line = text.trim();
	if (!line || isKnownName(line)) return { name: line, quantity: '' };
	const split = splitQuantity(line);
	if (split.quantity) return split;
	const trail = TRAILING_AMOUNT.exec(line);
	if (trail) {
		const [, rest, amount, unit] = trail;
		if (amountOk(amount, unit)) {
			return { name: rest.trim(), quantity: cleanSpaces(line.slice(rest.length)) };
		}
	}
	return { name: line, quantity: '' };
}
