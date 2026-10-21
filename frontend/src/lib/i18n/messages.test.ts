// [D-333] One word per thing, as one look per thing: slips a wording audit
// found in both languages, refused here so they do not come back. The rules
// are wording.json, which internal/docquotes holds the user docs to as well.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import wording from './wording.json';

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

describe('the messages keep one wording', () => {
	for (const [locale, rules] of Object.entries(wording)) {
		it(`in ${locale}`, () => {
			const slips = Object.entries(read(locale))
				.filter(([key]) => !key.startsWith('$'))
				.flatMap(([key, message]) =>
					texts(message).flatMap((text) =>
						rules
							.filter(({ pattern }) => new RegExp(pattern).test(text))
							.map(({ why }) => `${key}: ${why}`)
					)
				);
			expect(slips).toEqual([]);
		});
	}
});
