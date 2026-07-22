#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'assets');
const targetIcoPath = path.join(assetsDir, 'icon.ico');
const targetPngPath = path.join(assetsDir, 'icon.png');

const iconSizes = [16, 20, 24, 32, 48, 64, 128, 256];

function createIconSvg(size) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="56" fill="#08111f"/>
      <path d="M36 36h44l48 138 48-138h44l-72 184h-40L36 36z" fill="#0a66c2"/>
      <path d="M84 34h20l35 96 35-96h20l-47 124h-16L84 34z" fill="#30a7ff" opacity=".9"/>
      <circle cx="196" cy="72" r="34" fill="#ffffff"/>
      <path d="M164 72h64M196 38c-12 12-18 23-18 34s6 22 18 34M196 38c12 12 18 23 18 34s-6 22-18 34M196 38v68" fill="none" stroke="#08111f" stroke-width="8" stroke-linecap="round"/>
    </svg>
  `);
}

function createIcoEntry(pngBuffer, size, offset) {
  const directoryEntry = Buffer.alloc(16);
  directoryEntry.writeUInt8(size >= 256 ? 0 : size, 0);
  directoryEntry.writeUInt8(size >= 256 ? 0 : size, 1);
  directoryEntry.writeUInt8(0, 2);
  directoryEntry.writeUInt8(0, 3);
  directoryEntry.writeUInt16LE(1, 4);
  directoryEntry.writeUInt16LE(32, 6);
  directoryEntry.writeUInt32LE(pngBuffer.length, 8);
  directoryEntry.writeUInt32LE(offset, 12);
  return directoryEntry;
}

async function main() {
  fs.mkdirSync(assetsDir, { recursive: true });

  const pngBuffers = await Promise.all(iconSizes.map((size) =>
    sharp(createIconSvg(size), { density: 384 })
      .resize(size, size, { fit: 'cover' })
      .png()
      .toBuffer()
  ));

  fs.writeFileSync(targetPngPath, pngBuffers[pngBuffers.length - 1]);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);

  let imageOffset = header.length + iconSizes.length * 16;
  const directoryEntries = pngBuffers.map((pngBuffer, index) => {
    const entry = createIcoEntry(pngBuffer, iconSizes[index], imageOffset);
    imageOffset += pngBuffer.length;
    return entry;
  });

  fs.writeFileSync(targetIcoPath, Buffer.concat([header, ...directoryEntries, ...pngBuffers]));

  console.log('[generate-app-icon] generated app icons', {
    targetIcoPath,
    targetPngPath,
    sizes: iconSizes,
  });
}

main().catch((error) => {
  console.error('[generate-app-icon] failed', error);
  process.exit(1);
});
