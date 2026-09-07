const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const nextBuildDir = path.join(workspaceRoot, '.next');

try {
  fs.rmSync(nextBuildDir, { recursive: true, force: true });
  console.log('[dev] cleared .next before starting dev servers');
} catch (error) {
  console.warn('[dev] failed to clear .next:', error.message);
}

const concurrentlyBin = path.join(
  workspaceRoot,
  'node_modules',
  'concurrently',
  'dist',
  'bin',
  'index.js'
);

const child = spawn(
  process.execPath,
  [
    concurrentlyBin,
    '--kill-others-on-fail',
    'next dev --port 3000',
    'node server/socket-server.js',
  ],
  {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: process.env,
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
