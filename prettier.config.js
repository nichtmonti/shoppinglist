// Formatting is owned at the repo ROOT so that every path — frontend/, e2e/ and
// the loose config files — resolves the SAME options. Prettier searches upward
// from each file it formats, so while this lived in frontend/ nothing outside it
// was covered: an `npx prettier` on an e2e spec quietly fell back to prettier's
// defaults (double quotes, 2-space indent, 80 columns) and reformatted a file
// that was already in house style.
//
// What is deliberately NOT formatted (YAML, Markdown, the Go-written seed JSON)
// is listed with its reasoning in .prettierignore, which must stay next to this
// file — prettier resolves the ignore file from the CWD, not from the config.

/** @type {import("prettier").Config} */
const config = {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100,
	plugins: ['prettier-plugin-svelte'],
	overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }]
};

export default config;
