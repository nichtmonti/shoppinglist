// A minimal brace parser for the tests that read the app's own CSS: preludes,
// declarations and nesting, no strings or escapes (the app's CSS has no brace
// or semicolon inside a string).

export interface CssNode {
	prelude: string;
	decls: [string, string][];
	children: CssNode[];
}

export function parseCss(css: string): CssNode[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	let i = 0;
	function block(): { decls: [string, string][]; children: CssNode[] } {
		const decls: [string, string][] = [];
		const children: CssNode[] = [];
		let buf = '';
		while (i < text.length) {
			const c = text[i++];
			if (c === '{') {
				const prelude = buf.trim();
				buf = '';
				children.push({ prelude, ...block() });
			} else if (c === '}') {
				break;
			} else if (c === ';') {
				const d = buf.trim();
				buf = '';
				const colon = d.indexOf(':');
				if (colon > 0) decls.push([d.slice(0, colon).trim(), d.slice(colon + 1).trim()]);
			} else {
				buf += c;
			}
		}
		const tail = buf.trim();
		const colon = tail.indexOf(':');
		if (colon > 0) decls.push([tail.slice(0, colon).trim(), tail.slice(colon + 1).trim()]);
		return { decls, children };
	}
	return block().children;
}
