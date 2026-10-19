// [D-254] the text list parser: what "Die Einkaufsliste" shares, and the
// plainer lists other apps, notes and chats produce.
import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH, detectStructured, parseTextList, structuredProblem } from './text-import';
import { t } from './i18n';

// Verbatim from the app's share, trailing space after the name included.
const EINKAUFSLISTE = `Hamburg


[Obst - Gemüse - Nüsse]
Mango
Paprika, rot

[Saucen - Gewürze - Dressings - Öle]
Gelbe currypaste

[Backwaren]
Brot

[Brotaufstrich]
Ahornsirup

[Müsli - Cornflakes - Cerealien]
Chiasamen
Sonnenblumenkerne

[Kühltheke - Milchprodukte]
Erbsenmilch
`;

describe('parseTextList', () => {
	it('reads a Die Einkaufsliste share: title, sections, one item per line', () => {
		const parsed = parseTextList(EINKAUFSLISTE);
		expect(parsed.title).toBe('Hamburg');
		expect(parsed.entries).toEqual([
			{ name: 'Mango', quantity: '', section: 'Obst - Gemüse - Nüsse', checked: false },
			{ name: 'Paprika, rot', quantity: '', section: 'Obst - Gemüse - Nüsse', checked: false },
			{
				name: 'Gelbe currypaste',
				quantity: '',
				section: 'Saucen - Gewürze - Dressings - Öle',
				checked: false
			},
			{ name: 'Brot', quantity: '', section: 'Backwaren', checked: false },
			{ name: 'Ahornsirup', quantity: '', section: 'Brotaufstrich', checked: false },
			{
				name: 'Chiasamen',
				quantity: '',
				section: 'Müsli - Cornflakes - Cerealien',
				checked: false
			},
			{
				name: 'Sonnenblumenkerne',
				quantity: '',
				section: 'Müsli - Cornflakes - Cerealien',
				checked: false
			},
			{ name: 'Erbsenmilch', quantity: '', section: 'Kühltheke - Milchprodukte', checked: false }
		]);
	});

	it('takes no title from a plain list, so no item is lost to one', () => {
		expect(parseTextList('Milch\n\nBrot\nEier')).toEqual({
			title: null,
			cut: false,
			entries: [
				{ name: 'Milch', quantity: '', section: null, checked: false },
				{ name: 'Brot', quantity: '', section: null, checked: false },
				{ name: 'Eier', quantity: '', section: null, checked: false }
			]
		});
	});

	it('takes an unmarked first line above a marked list as its title', () => {
		const parsed = parseTextList('Wocheneinkauf\n☐ Milch\n☑ Brot\n☐ Eier');
		expect(parsed.title).toBe('Wocheneinkauf');
		expect(parsed.entries.map((e) => [e.name, e.checked])).toEqual([
			['Milch', false],
			['Brot', true],
			['Eier', false]
		]);
	});

	it('strips bullets, numbers and Markdown checkboxes', () => {
		const parsed = parseTextList(
			'- Milch\n* Brot\n• Eier\n1. Käse\n2) Butter\n- [ ] Salz\n- [x] Zucker'
		);
		expect(parsed.entries.map((e) => [e.name, e.checked])).toEqual([
			['Milch', false],
			['Brot', false],
			['Eier', false],
			['Käse', false],
			['Butter', false],
			['Salz', false],
			['Zucker', true]
		]);
	});

	it('strips the other bullets Markdown, Google Docs and Apple Notes write', () => {
		const parsed = parseTextList('+ Senf\n◦ Salz\n○ Brot\n● Eier\n▪ Reis\n‣ Mehl');
		expect(parsed.entries.map((e) => e.name)).toEqual([
			'Senf',
			'Salz',
			'Brot',
			'Eier',
			'Reis',
			'Mehl'
		]);
	});

	it('reads messages copied from a chat without their sender and time', () => {
		const parsed = parseTextList(
			'[12.10.25, 18:03] Anna: Milch\n[12.10.25, 18:04] Anna: 2 Brot\n[10/12/25, 6:05 PM] Ben: Eggs'
		);
		expect(parsed.entries.map((e) => [e.quantity, e.name])).toEqual([
			['', 'Milch'],
			['2', 'Brot'],
			['', 'Eggs']
		]);
	});

	it("reads Telegram Desktop's copied messages the same way", () => {
		// tdesktop 7.x (history_item_text.cpp): „[<short date> <time>] <name>: “
		// before each message, the date in the system's short format.
		const parsed = parseTextList(
			'[12.10.26 18:03] Anna: Milch\n[12.10.26 18:04] Anna: 500 g Mehl\n[10/12/26 6:05 PM] Ben: Eggs'
		);
		expect(parsed.entries.map((e) => [e.quantity, e.name])).toEqual([
			['', 'Milch'],
			['500 g', 'Mehl'],
			['', 'Eggs']
		]);
	});

	it('reads a text past the cap up to its last whole line, and says it was cut', () => {
		const line = 'Kartoffeln\n';
		const text = line.repeat(Math.ceil(MAX_TEXT_LENGTH / line.length) + 1);
		const parsed = parseTextList(text);
		expect(parsed.cut).toBe(true);
		expect(parsed.entries.every((e) => e.name === 'Kartoffeln')).toBe(true);
		expect(parsed.entries.length).toBe(Math.floor(MAX_TEXT_LENGTH / line.length));
		expect(parseTextList('Milch').cut).toBe(false);
	});

	it('reads a line ending in a colon over items as their section', () => {
		const parsed = parseTextList('Obst:\n- Äpfel\n- Birnen\nRewe:\nMilch: 2 l\nBrot:');
		expect(parsed.entries.map((e) => [e.name, e.section])).toEqual([
			['Äpfel', 'Obst'],
			['Birnen', 'Obst'],
			['Milch: 2 l', 'Rewe'],
			['Brot:', 'Rewe']
		]);
	});

	it('makes no heading of the line above a stray leading space', () => {
		const parsed = parseTextList('Milch\nBrot\n Eier');
		expect(parsed.entries.map((e) => [e.name, e.section])).toEqual([
			['Milch', null],
			['Brot', null],
			['Eier', null]
		]);
	});

	it('reads Markdown headings as sections', () => {
		const parsed = parseTextList('# Obst\n- Äpfel\n## Getränke\n- Wasser');
		expect(parsed.title).toBeNull();
		expect(parsed.entries).toEqual([
			{ name: 'Äpfel', quantity: '', section: 'Obst', checked: false },
			{ name: 'Wasser', quantity: '', section: 'Getränke', checked: false }
		]);
	});

	it('copes with CRLF, non-breaking and zero-width spaces', () => {
		const parsed = parseTextList('Liste\r\n\r\n[Obst]\r\nRote\u00a0Beete \u200b\r\n');
		expect(parsed.title).toBe('Liste');
		expect(parsed.entries).toEqual([
			{ name: 'Rote Beete', quantity: '', section: 'Obst', checked: false }
		]);
	});

	it('finds nothing in a text of headers and blank lines', () => {
		expect(parseTextList('\n[Obst]\n\n[Backwaren]\n').entries).toEqual([]);
		expect(parseTextList('').entries).toEqual([]);
	});

	it('reads a leading amount as the quantity', () => {
		const parsed = parseTextList(
			[
				'2 Äpfel',
				'1 kg Kartoffeln festkochend',
				'1kg Mehl',
				'500 g Butter',
				'1,5 l Milch',
				'2x Joghurt',
				'½ Bund Petersilie',
				'3 Stk. Paprika',
				'12 Eier',
				'500 Gramm Hackfleisch',
				'2 liters water',
				'1 Kilo Reis',
				'2 Rollen Klopapier',
				'1 Kopf Salat',
				'2 × Milch',
				'1 dozen eggs'
			].join('\n')
		);
		expect(parsed.entries.map((e) => [e.quantity, e.name])).toEqual([
			['2', 'Äpfel'],
			['1 kg', 'Kartoffeln festkochend'],
			['1kg', 'Mehl'],
			['500 g', 'Butter'],
			['1,5 l', 'Milch'],
			['2x', 'Joghurt'],
			['½ Bund', 'Petersilie'],
			['3 Stk.', 'Paprika'],
			['12', 'Eier'],
			['500 Gramm', 'Hackfleisch'],
			['2 liters', 'water'],
			['1 Kilo', 'Reis'],
			['2 Rollen', 'Klopapier'],
			['1 Kopf', 'Salat'],
			['2 ×', 'Milch'],
			['1 dozen', 'eggs']
		]);
	});

	it('leaves a number that is part of the name alone', () => {
		const parsed = parseTextList(
			['7up', '4711 Echt Kölnisch Wasser', '1,5 % Milch', 'Milch 3,5 %', 'Glas'].join('\n')
		);
		expect(parsed.entries.map((e) => [e.quantity, e.name])).toEqual([
			['', '7up'],
			['', '4711 Echt Kölnisch Wasser'],
			['', '1,5 % Milch'],
			['', 'Milch 3,5 %'],
			['', 'Glas']
		]);
	});

	it('reads a trailing amount in brackets, OurGroceries style, and nothing else in brackets', () => {
		const parsed = parseTextList('Kartoffeln (3)\nMilch (2 Liter)\nPaprika (rot)');
		expect(parsed.entries.map((e) => [e.quantity, e.name])).toEqual([
			['3', 'Kartoffeln'],
			['2 Liter', 'Milch'],
			['', 'Paprika (rot)']
		]);
	});

	it('reads a Mealie copy, as text and as Markdown', () => {
		const text = '[Obst & Gemüse]\n2 Äpfel\n\n[Milchprodukte]\n1 l Milch\n';
		const markdown = '# Obst & Gemüse\n- [ ] 2 Äpfel\n\n# Milchprodukte\n- [ ] 1 l Milch\n';
		const expected = [
			{ name: 'Äpfel', quantity: '2', section: 'Obst & Gemüse', checked: false },
			{ name: 'Milch', quantity: '1 l', section: 'Milchprodukte', checked: false }
		];
		expect(parseTextList(text)).toEqual({ title: null, entries: expected, cut: false });
		expect(parseTextList(markdown)).toEqual({ title: null, entries: expected, cut: false });
	});

	it("reads Tandoor's Markdown list: a bare line over indented items is their section", () => {
		const parsed = parseTextList(
			'\nGemüse\n 2  Äpfel\n 1 kg Kartoffeln\n\nMilchprodukte\n 1 l Milch\n'
		);
		expect(parsed).toEqual({
			title: null,
			cut: false,
			entries: [
				{ name: 'Äpfel', quantity: '2', section: 'Gemüse', checked: false },
				{ name: 'Kartoffeln', quantity: '1 kg', section: 'Gemüse', checked: false },
				{ name: 'Milch', quantity: '1 l', section: 'Milchprodukte', checked: false }
			]
		});
	});

	it('takes no section from an unindented list', () => {
		expect(parseTextList('Gemüse\nÄpfel').entries.map((e) => e.section)).toEqual([null, null]);
	});

	it('reads a lone line as an item, not a title', () => {
		expect(parseTextList('Milch')).toEqual({
			title: null,
			cut: false,
			entries: [{ name: 'Milch', quantity: '', section: null, checked: false }]
		});
	});
});

// [D-254] a file pasted where a list goes is named, not read line by line.
describe('detectStructured', () => {
	const FORMAT = 'shoppinglist-backup';
	const kind = (text: string) => detectStructured(text, FORMAT);

	it('knows a backup of this app from other JSON', () => {
		expect(kind(JSON.stringify({ format: FORMAT, version: 2, items: [] }, null, 2))).toBe('backup');
		expect(kind('{"title":"Einkauf","listContent":[{"text":"Milch"}]}')).toBe('json');
		expect(kind('[{"name":"Milch"}]')).toBe('json');
	});

	it('names the exports other apps make', () => {
		expect(kind('Amount , Unit , Food\nGemüse,,\n2,,Äpfel\n1,kg,Kartoffeln')).toBe('csv');
		expect(kind('TYPE,CONTENT,DESCRIPTION,PRIORITY\ntask,Äpfel,,4\ntask,"Milch, Hafer",,4')).toBe(
			'csv'
		);
		expect(kind('Menge;Artikel;Notiz\n2;Äpfel;\n1;Milch;bio')).toBe('csv');
		expect(kind('|Amount|Unit|Food|\n|-|-|-|\n|2||Äpfel|')).toBe('table');
		expect(kind('---\nitems:\n  - Milch\n  - Brot')).toBe('yaml');
		expect(kind('list:\n  name: Einkauf\n  items: 3')).toBe('yaml');
		expect(kind('<ul><li>Milch</li><li>Brot</li></ul>')).toBe('markup');
	});

	it('leaves a shopping list a list', () => {
		for (const list of [
			'Hamburg\n\n[Obst - Gemüse - Nüsse]\nMango\nPaprika, rot\n\n[Backwaren]\nBrot',
			'[Obst]\nÄpfel\nBirnen',
			'Paprika, rot\nSalz, grob\nMilch',
			'Paprika, rot\nSalz, grob',
			'Milch: 2 l\nBrot: Vollkorn',
			'Shopping:\nMilk: 2\nEggs: 12\nBread: 1',
			'Einkauf:\nMilch: 2\nBrot: 1\nEier: 10',
			'Rewe:\n- Milch: 2\n- Butter: 1',
			'Brot, Butter, Käse\nÄpfel, Birnen, Bananen',
			'[12.10.25, 18:03] Anna: Milch, Brot, Eier\n[12.10.25, 18:04] Anna: Butter, Käse, Wurst',
			'# Obst\n- [ ] 2 Äpfel',
			'Milch',
			''
		]) {
			expect(kind(list), list).toBeNull();
		}
	});
});

describe('structuredProblem', () => {
	it('imports a backup from the paste screen and refuses it on a list', () => {
		expect(structuredProblem('backup', false)).toBeNull();
		expect(structuredProblem('backup', true)).toBe(t('import_backup_elsewhere'));
	});

	it('names every other kind of file', () => {
		expect(structuredProblem('json', false)).toBe(t('import_format_json'));
		expect(structuredProblem('markup', true)).toBe(t('import_format_markup'));
		expect(structuredProblem('table', false)).toBe(t('import_format_table'));
		expect(structuredProblem('csv', false)).toBe(t('import_format_csv'));
		expect(structuredProblem('yaml', false)).toBe(t('import_format_yaml'));
	});
});
