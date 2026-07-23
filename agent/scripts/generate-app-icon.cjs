#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const assetsDir = path.join(projectRoot, 'assets');
const targetIcoPath = path.join(assetsDir, 'icon.ico');
const targetPngPath = path.join(assetsDir, 'icon.png');
const sourceIconPath = path.join(workspaceRoot, 'public', 'Vorion Logo 1024.png');

const iconSizes = [16, 20, 24, 32, 48, 64, 128, 256];

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

  if (!fs.existsSync(sourceIconPath)) {
    throw new Error(`Source icon not found: ${sourceIconPath}`);
  }

  const pngBuffers = await Promise.all(iconSizes.map((size) =>
    sharp(sourceIconPath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
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
    sourceIconPath,
    targetIcoPath,
    targetPngPath,
    sizes: iconSizes,
  });
}

main().catch((error) => {
  console.error('[generate-app-icon] failed', error);
  process.exit(1);
});
