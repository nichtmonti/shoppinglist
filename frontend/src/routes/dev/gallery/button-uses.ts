// Where each Button variant and size is used, read from the source, so the
// buttons page (ButtonGallery) shows the family as it is, not as it was
// written down. Dev only: the gallery route is never in a production build.

export interface Use {
	file: string;
	line: number;
}
export interface ButtonUses {
	variants: Map<string, Use[]>;
	sizes: Map<string, Use[]>;
}

const add = (map: Map<string, Use[]>, key: string, use: Use) =>
	map.set(key, [...(map.get(key) ?? []), use]);

/** The opening tag starting at `start`, up to its `>` outside `{…}` and quotes. */
function openingTag(source: string, start: number): string {
	let depth = 0;
	let quote = '';
	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c === '{') depth++;
		else if (c === '}') depth--;
		else if (c === '>' && depth === 0) return source.slice(start, i);
	}
	return source.slice(start);
}

/** The expression of `name={…}` in a tag, braces balanced. */
function expression(tag: string, name: string): string | null {
	const at = tag.search(new RegExp(`\\s${name}=\\{`));
	if (at < 0) return null;
	const start = tag.indexOf('{', at);
	let depth = 0;
	for (let i = start; i < tag.length; i++) {
		if (tag[i] === '{') depth++;
		else if (tag[i] === '}' && --depth === 0) return tag.slice(start + 1, i);
	}
	return tag.slice(start + 1);
}

/** Each `<Button …>` and `buttonVariants({ … })` in one file. An attribute left
 *  out is the default; one set from an expression counts every string it can
 *  pick (`danger === 'strong' ? 'danger' : 'default'`), or `dynamic`; the
 *  shorthand `{size}` hands the caller's value on and counts as `passed-through`. */
export function scanButtons(file: string, source: string, into: ButtonUses): void {
	const lineAt = (index: number) => source.slice(0, index).split('\n').length;
	for (const m of source.matchAll(/<Button\b/g)) {
		const tag = openingTag(source, m.index);
		const use = { file, line: lineAt(m.index) };
		const read = (name: string): string[] => {
			// `{size}`: passed through from the caller, which is counted there.
			if (new RegExp(`[\\s{]\\{${name}\\}`).test(tag)) return ['passed-through'];
			const expr = expression(tag, name);
			if (expr !== null) {
				const picks = [...expr.matchAll(/'([^']+)'/g)].map((l) => l[1]);
				return picks.length ? picks : ['dynamic'];
			}
			return [new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1] ?? 'default'];
		};
		for (const v of read('variant')) add(into.variants, v, use);
		for (const z of read('size')) add(into.sizes, z, use);
	}
	for (const m of source.matchAll(/buttonVariants\(\{([^}]*)\}\)/g)) {
		const use = { file, line: lineAt(m.index) };
		add(into.variants, /variant:\s*'([^']+)'/.exec(m[1])?.[1] ?? 'default', use);
		add(into.sizes, /size:\s*'([^']+)'/.exec(m[1])?.[1] ?? 'default', use);
	}
}

export function buttonUses(): ButtonUses {
	const sources = import.meta.glob<string>(
		['/src/lib/**/*.svelte', '/src/routes/**/*.svelte', '!/src/routes/dev/**'],
		{ query: '?raw', import: 'default', eager: true }
	);
	const uses: ButtonUses = { variants: new Map(), sizes: new Map() };
	for (const [path, source] of Object.entries(sources)) {
		scanButtons(path.replace('/src/', ''), source, uses);
	}
	return uses;
}
