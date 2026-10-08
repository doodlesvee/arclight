// Renders the app icon in every size it is needed at.
//
//   node scripts/make-icons.mjs
//
// The outputs are committed, so this only has to run when the design changes.
// The glyph is the clapperboard from lucide (the one in the sidebar), drawn on
// the app's dark background.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "apps/web/public");
const iconsDir = path.join(publicDir, "icons");
const iconsetDir = path.join(root, "scripts/macos/AppIcon.iconset");

const GLYPH = [
  "m12.296 3.464 3.02 3.956",
  "M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z",
  "M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  "m6.18 5.276 3.1 3.899",
];

/**
 * An icon on a 512 canvas.
 *
 * `inset` is the transparent margin around the rounded square (macOS wants
 * one, so the icon sits in the Dock like the system's own); `radius` rounds
 * it, and 0 gives the full-bleed square that maskable and iOS icons need —
 * the platform applies its own mask. `glyph` is the glyph's size as a share of
 * the canvas; maskable icons keep it inside the central safe zone.
 */
function svg({ inset = 0, radius = 0, glyph = 0.58 }) {
  const size = 512 - inset * 2;
  const scale = (512 * glyph) / 24;
  const offset = (512 - 24 * scale) / 2;
  const paths = GLYPH.map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2b30"/>
      <stop offset="1" stop-color="#141414"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
</svg>
`;
}

const rounded = svg({ radius: 112 });
const macos = svg({ inset: 52, radius: 96, glyph: 0.46 });
const fullBleed = svg({ glyph: 0.5 });

async function png(source, size, file) {
  await sharp(Buffer.from(source), { density: 384 })
    .resize(size, size)
    .png()
    .toFile(file);
}

mkdirSync(iconsDir, { recursive: true });
mkdirSync(iconsetDir, { recursive: true });

writeFileSync(path.join(iconsDir, "icon.svg"), rounded);
// The tab and window icon, so it matches the installed one.
writeFileSync(path.join(publicDir, "favicon.svg"), rounded);

await png(rounded, 192, path.join(iconsDir, "icon-192.png"));
await png(rounded, 512, path.join(iconsDir, "icon-512.png"));
await png(fullBleed, 512, path.join(iconsDir, "icon-maskable-512.png"));
await png(fullBleed, 180, path.join(iconsDir, "apple-touch-icon.png"));

// The sizes `iconutil` expects in an .iconset.
for (const base of [16, 32, 128, 256, 512]) {
  await png(macos, base, path.join(iconsetDir, `icon_${base}x${base}.png`));
  await png(macos, base * 2, path.join(iconsetDir, `icon_${base}x${base}@2x.png`));
}

console.log("Icons written to", path.relative(root, iconsDir), "and", path.relative(root, iconsetDir));
