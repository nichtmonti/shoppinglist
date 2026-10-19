// vite-plugin-openmoji.ts ([D-181]): OpenMoji file stem → asset URL, for the
// emoji in src/lib/emoji-set.json. An ambient file of its own: app.d.ts is a
// module, where this would read as augmenting a module that does not exist.
declare module 'virtual:openmoji' {
	const urls: Record<string, string>;
	export default urls;
}
