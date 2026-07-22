#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const buildDir = path.join(projectRoot, 'build');
const assetsDir = path.join(projectRoot, 'assets');
const workspaceLogoPath = path.resolve(projectRoot, '..', 'public', 'Vorion With bg.png');
const appIconPaths = [
  path.join(assetsDir, 'icon.png'),
  path.join(assetsDir, 'icon.ico'),
];

fs.mkdirSync(buildDir, { recursive: true });

const copiedFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) continue;

    const relativePath = path.relative(srcDir, fullPath);
    const targetPath = path.join(buildDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(fullPath, targetPath);
    copiedFiles.push(relativePath);
  }
}

walk(srcDir);

if (fs.existsSync(workspaceLogoPath)) {
  const rendererLogoPath = path.join(buildDir, 'renderer', 'logo.png');
  fs.mkdirSync(path.dirname(rendererLogoPath), { recursive: true });
  fs.copyFileSync(workspaceLogoPath, rendererLogoPath);
  copiedFiles.push(path.relative(buildDir, rendererLogoPath));
}

for (const iconPath of appIconPaths) {
  if (!fs.existsSync(iconPath)) continue;
  const targetPath = path.join(buildDir, path.basename(iconPath));
  fs.copyFileSync(iconPath, targetPath);
  copiedFiles.push(path.relative(buildDir, targetPath));
}

console.log(`[copy-electron-assets] copied ${copiedFiles.length} static file(s) to ${buildDir}`);
