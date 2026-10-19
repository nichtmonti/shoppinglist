// [D-285] What the add field reads off what was typed, beside the text
// import's rule it extends ([D-254]; text-import.test.ts covers that rule
// inside whole lists).
import { describe, expect, it } from 'vitest';
import { readTypedAmount, splitQuantity } from './amount';

const nothingKnown = () => false;
const read = (text: string, known: string[] = []) =>
	readTypedAmount(text, (name) => known.includes(name));

describe('readTypedAmount', () => {
	it.each([
		['2 l Milch', 'Milch', '2 l'],
		['500g Butter', 'Butter', '500g'],
		['Milch 2 l', 'Milch', '2 l'],
		['Milch 2l', 'Milch', '2l'],
		['Eier 10', 'Eier', '10'],
		['Eier 10 Stück', 'Eier', '10 Stück'],
		['Zwiebeln (3)', 'Zwiebeln', '3'],
		['  mil 2  ', 'mil', '2']
	])('reads %j as %j with %j', (text, name, quantity) => {
		expect(read(text)).toEqual({ name, quantity });
	});

	// Typed on the way to "500 g Gouda": no item is called "g" or "kg".
	it.each(['500 g', '2 kg', '1 l', '3 Stk.', '2 x'])(
		'leaves %j, an amount without its name, as typed',
		(text) => {
			expect(readTypedAmount(text, nothingKnown)).toEqual({ name: text, quantity: '' });
		}
	);

	it('reads the name once its first letter is typed', () => {
		expect(read('500 g G')).toEqual({ name: 'G', quantity: '500 g' });
	});

	it.each(['7up', 'Milch', '1,5 % Milch', 'Milch 1,5 %', 'Wasser 4711', '2', 'Ariel 3in1'])(
		'leaves %j a name',
		(text) => {
			expect(readTypedAmount(text, nothingKnown)).toEqual({ name: text.trim(), quantity: '' });
		}
	);

	it('keeps the number of a name the list or the dictionary has as written', () => {
		expect(read('Tempo 100', ['Tempo 100'])).toEqual({ name: 'Tempo 100', quantity: '' });
		expect(read('Tempo 100')).toEqual({ name: 'Tempo', quantity: '100' });
	});

	it('reads an empty field as nothing', () => {
		expect(read('   ')).toEqual({ name: '', quantity: '' });
	});
});

describe('splitQuantity', () => {
	it('reads no bare amount at the end: a line of an imported list keeps it', () => {
		expect(splitQuantity('Milch 2 l')).toEqual({ name: 'Milch 2 l', quantity: '' });
	});
});
