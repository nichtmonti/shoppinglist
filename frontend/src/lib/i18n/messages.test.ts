// [D-333] One word per thing, as one look per thing: slips a wording audit
// found in both languages, refused here so they do not come back.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Message = string | Message[] | { [key: string]: Message };

const read = (locale: string): Record<string, Message> =>
	JSON.parse(readFileSync(new URL(`../../../messages/${locale}.json`, import.meta.url), 'utf8'));

/** Every text a message can show, its plural variants included. */
function texts(message: Message): string[] {
	if (typeof message === 'string') return [message];
	if (Array.isArray(message)) return message.flatMap(texts);
	return Object.entries(message)
		.filter(([key]) => key !== 'declarations' && key !== 'selectors')
		.flatMap(([, value]) => texts(value));
}

const RULES: Record<string, [RegExp, string][]> = {
	de: [
		[/[A-Za-zÄÖÜäöüß]…/, 'a space before „…“, as German sets it'],
		[/\banle(?:gen|gt)\b|angelegt|anzulegen/, '„erstellen“, the buttons’ word, not „anlegen“']
	],
	en: [
		[/ …/, 'no space before "…", as English sets it'],
		[/\.\.\./, '"…", not three full stops'],
		[/’/, 'a straight apostrophe, as the rest'],
		[/\blogins?\b/i, '"sign-in", not "login"'],
		[/\b(?:cancelled|colour|grey|any more)\b/i, 'US spelling, as "Color" and "Gray"'],
		[/\b(?:un)?tick(?:ed)?\b/i, '"check off" and "uncheck", not "tick"']
	]
};

describe('the messages keep one wording', () => {
	for (const [locale, rules] of Object.entries(RULES)) {
		it(`in ${locale}`, () => {
			const slips = Object.entries(read(locale))
				.filter(([key]) => !key.startsWith('$'))
				.flatMap(([key, message]) =>
					texts(message).flatMap((text) =>
						rules.filter(([pattern]) => pattern.test(text)).map(([, why]) => `${key}: ${why}`)
					)
				);
			expect(slips).toEqual([]);
		});
	}
});
