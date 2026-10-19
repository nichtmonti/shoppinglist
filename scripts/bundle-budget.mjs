// The boot path's bundle budget ([D-203]): sums the gzipped weight of every
// modulepreload chunk in the built index.html, the bytes a first paint
// actually waits on. CI runs it after the frontend build; by hand, after one:
//   node scripts/bundle-budget.mjs
// Budget: 220 KiB gz.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'frontend', 'build');
const BUDGET_KIB = 220;

const htmlPath = join(buildDir, 'index.html');
if (!existsSync(htmlPath)) {
	console.error(`no build at ${htmlPath} — run the frontend build first`);
	process.exit(2);
}
const html = readFileSync(htmlPath, 'utf8');
const links = [...html.matchAll(/<link[^>]*>/g)].map((m) => m[0]);
const hrefOf = (tag) => tag.match(/href="([^"]+)"/)?.[1];
const hrefs = links
	.filter((t) => t.includes('rel="modulepreload"'))
	.map(hrefOf)
	.filter(Boolean);
const css = links
	.filter((t) => t.includes('rel="stylesheet"'))
	.map(hrefOf)
	.filter(Boolean);

let total = 0;
const rows = [];
for (const href of [...hrefs, ...css]) {
	const path = join(buildDir, href.replace(/^\//, ''));
	if (!existsSync(path)) {
		rows.push({ file: href, kib: 'MISSING' });
		continue;
	}
	const gz = gzipSync(readFileSync(path)).length;
	total += gz;
	rows.push({ file: href, kib: (gz / 1024).toFixed(1) });
}
const missing = rows.filter((r) => r.kib === 'MISSING');
rows.sort((a, b) => (parseFloat(b.kib) || 0) - (parseFloat(a.kib) || 0));
for (const r of rows.slice(0, 15)) console.log(`${String(r.kib).padStart(8)} KiB gz  ${r.file}`);
console.log(`   ... (${rows.length} files total)`);
const totalKib = total / 1024;
console.log(`TOTAL boot path: ${totalKib.toFixed(1)} KiB gz (budget ${BUDGET_KIB})`);
if (missing.length > 0) {
	// A missing boot-path file adds nothing to the total, so it could pass the budget.
	console.error(`FAIL: ${missing.length} boot-path file(s) missing from ${buildDir}`);
	process.exit(1);
}
if (totalKib > BUDGET_KIB) {
	console.error('OVER BUDGET');
	process.exit(1);
}
console.log('WITHIN BUDGET');
