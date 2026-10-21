import sharp from 'sharp';

// Two README screenshots side by side as one PNG ([D-286]). The README gives
// each pair a fixed width, and Codeberg caps an image at its column: a laptop
// gets two pairs to a row at that width, a phone one pair scaled to its width.
// Codeberg allows no CSS, <picture> or srcset that could do this otherwise.
//
//   node shots/pair.ts LEFT.png RIGHT.png OUT.png

/** Between the two phones, in image pixels: the few pixels of space the
 *  README puts between two pairs on a row, at the pairs' own scale. */
const GAP = 16;

const [left, right, out] = process.argv.slice(2);
if (!left || !right || !out) {
	console.error('usage: node shots/pair.ts LEFT.png RIGHT.png OUT.png');
	process.exit(2);
}

const [l, r] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
await sharp({
	create: {
		width: l.width + GAP + r.width,
		height: Math.max(l.height, r.height),
		channels: 4,
		background: { r: 0, g: 0, b: 0, alpha: 0 }
	}
})
	.composite([
		{ input: left, left: 0, top: 0 },
		{ input: right, left: l.width + GAP, top: 0 }
	])
	.png()
	.toFile(out);
