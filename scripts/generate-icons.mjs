// Builds the app-icon PNGs and favicon.ico from public/icons/icon.svg.
//   node scripts/generate-icons.mjs
// Uses `sharp` (already installed by Next.js; it is not a dependency of this project).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public");
const svg = fs.readFileSync(path.join(root, "public/icons/icon.svg"));
const BG = "#10160f";

// Opaque PNG at `size`: the artwork scaled to fit, on the solid background (no alpha channel).
const png = (size) =>
  sharp(svg, { density: (72 * size) / 512 * 2 }).resize(size, size).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();

const files = {
  "icons/icon-192.png": 192,
  "icons/icon-512.png": 512,
  "icons/icon-maskable-512.png": 512, // same artwork: it already stays inside the safe zone
  "apple-touch-icon.png": 180,
};
for (const [name, size] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), await png(size));
  console.log("wrote", name, size);
}

// favicon.ico: PNG-compressed 16, 32 and 48 px images in one ICO container.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(png));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head[e] = s; head[e + 1] = s; head[e + 2] = 0; head[e + 3] = 0;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(images[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(out, "favicon.ico"), Buffer.concat([head, ...images]));
console.log("wrote favicon.ico", sizes.join(","));
