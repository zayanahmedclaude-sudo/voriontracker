#!/usr/bin/env node
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const buildDir = path.resolve(__dirname, '..', 'build');
const legacyDistDir = path.resolve(__dirname, '..', 'dist');
const maxAttempts = 5;
const retryDelayMs = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

async function stopProcessesInDir(targetDir) {
  if (process.platform !== 'win32') return;

  const normalizedDir = targetDir.replace(/'/g, "''");
  const script = `
    $target = [System.IO.Path]::GetFullPath('${normalizedDir}')
    $killed = @()
    Get-CimInstance Win32_Process | ForEach-Object {
      $path = $_.ExecutablePath
      if ($path -and $path.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed += "$($_.Name)#$($_.ProcessId)"
      }
    }
    $killed -join [Environment]::NewLine
  `;

  try {
    const { stdout } = await runPowerShell(script);
    const killed = stdout.trim();
    if (killed) {
      console.warn(`[clean-release] stopped process(es) using ${targetDir}:\n${killed}`);
    }
  } catch (error) {
    console.warn(`[clean-release] failed to query processes for ${targetDir}:`, error?.stderr || error?.message || error);
  }
}

async function removeDir(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        await stopProcessesInDir(targetDir);
      }
      if (attempt === maxAttempts) break;
      console.warn(`[clean-release] attempt ${attempt} failed for ${targetDir}, retrying in ${retryDelayMs}ms`, error.message);
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

Promise.all([
  removeDir(buildDir),
  removeDir(legacyDistDir),
])
  .then(() => {
    console.log(`[clean-release] prepared ${buildDir} and ${legacyDistDir}`);
  })
  .catch((error) => {
    console.error('[clean-release] failed to remove build artifacts:', error?.message || error);
    process.exit(1);
  });
