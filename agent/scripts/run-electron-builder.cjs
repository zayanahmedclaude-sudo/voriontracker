const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const outputName = `artifacts-${Date.now()}`;
const releaseDir = path.join(projectRoot, outputName);
const electronBuilderBin = path.join(
  projectRoot,
  'node_modules',
  'electron-builder',
  'cli.js'
);

const maxAttempts = 3;
const retryDelayMs = 5000;
const stagingPaths = [
  path.join(releaseDir, 'win-unpacked.tmp'),
  path.join(releaseDir, 'win-unpacked'),
];

function patchWindowsExtractionRename() {
  if (process.platform !== 'win32') return;
  const electronGetPath = path.join(projectRoot, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js');
  const marker = '[vorion] Windows EPERM extraction fallback';
  const original = fs.readFileSync(electronGetPath, 'utf8');
  if (original.includes(marker)) return;
  const needle = '        await fs.rename(tmpDir, dir);';
  if (!original.includes(needle)) {
    throw new Error('Unsupported app-builder-lib extraction implementation; cannot install Windows rename fallback');
  }
  const replacement = `        try {
            await fs.rename(tmpDir, dir);
        }
        catch (error) {
            if (process.platform !== "win32" || (error.code !== "EPERM" && error.code !== "EACCES")) throw error;
            // [vorion] Windows EPERM extraction fallback
            // Indexers and security tools can briefly hold the extracted directory open.
            // Copying its completed contents avoids a directory rename while preserving bytes.
            await fs.cp(tmpDir, dir, { recursive: true, force: true });
            // Cleanup is deferred to the build wrapper; waiting here can stall while an indexer still holds tmpDir.
            void fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }).catch(() => undefined);
        }`;
  fs.writeFileSync(electronGetPath, original.replace(needle, replacement), 'utf8');
  console.log('[build] installed Windows extraction rename fallback');
}

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      console.log('[build] removed stale artifact', filePath);
    }
  } catch (error) {
    console.warn('[build] failed to remove stale artifact', filePath, error.message);
  }
}

function cleanupReleaseArtifacts() {
  removeIfExists(path.join(releaseDir, 'vorion-tracker-1.0.0-x64.nsis.7z'));
  removeIfExists(path.join(releaseDir, 'Vorion Tracker 1.0.0.exe'));
  removeIfExists(path.join(releaseDir, 'Vorion Tracker Setup 1.0.0.exe'));
}

async function cleanupStagingDirectories() {
  for (const stagingPath of stagingPaths) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await fs.promises.rm(stagingPath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 500,
        });
        break;
      } catch (error) {
        if (attempt === 8) throw error;
        await wait(750 * attempt);
      }
    }
  }
}

function runBuilder() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [electronBuilderBin, '--win', '--x64', `--config.directories.output=${outputName}`], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  patchWindowsExtractionRename();
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`[build] retrying electron-builder (${attempt}/${maxAttempts}) after delay`);
      await wait(retryDelayMs);
    }

    cleanupReleaseArtifacts();
    try {
      await cleanupStagingDirectories();
    } catch (error) {
      console.error('[build] Windows is still locking the packaging directory. Close File Explorer windows and antivirus scans targeting the artifacts folder, then retry.', error.message);
      process.exitCode = 1;
      return;
    }
    const result = await runBuilder();

    if (result.code === 0) {
      const trustScriptSource = path.join(projectRoot, 'scripts', 'trust-vorion-installer.ps1');
      const trustScriptTarget = path.join(releaseDir, 'Trust-VorionInstaller.ps1');
      const trustLauncherSource = path.join(projectRoot, 'scripts', 'Trust-VorionInstaller.cmd');
      const trustLauncherTarget = path.join(releaseDir, 'Trust-VorionInstaller.cmd');
      fs.copyFileSync(trustScriptSource, trustScriptTarget);
      fs.copyFileSync(trustLauncherSource, trustLauncherTarget);
      console.log('[build] electron-builder completed successfully');
      console.log('[build] installer:', path.join(releaseDir, 'VorionTrackerSetup.exe'));
      console.log('[build] certificate trust helper:', trustScriptTarget);
      console.log('[build] certificate trust launcher:', trustLauncherTarget);
      return;
    }

    lastFailure = result;
    console.warn('[build] electron-builder failed', result);
  }

  process.exitCode = lastFailure?.code || 1;
}

main().catch((error) => {
  console.error('[build] unexpected build wrapper failure', error);
  process.exitCode = 1;
});
