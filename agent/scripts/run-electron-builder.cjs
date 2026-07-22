const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const electronBuilderBin = path.join(
  projectRoot,
  'node_modules',
  'electron-builder',
  'cli.js'
);

const maxAttempts = 3;
const retryDelayMs = 4000;

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

function runBuilder() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [electronBuilderBin, '--win', '--x64'], {
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
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`[build] retrying electron-builder (${attempt}/${maxAttempts}) after delay`);
      await wait(retryDelayMs);
    }

    cleanupReleaseArtifacts();
    const result = await runBuilder();

    if (result.code === 0) {
      console.log('[build] electron-builder completed successfully');
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
