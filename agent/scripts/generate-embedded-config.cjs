#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const agentRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(agentRoot, '..');
const outputPath = path.join(agentRoot, 'src', 'embedded-config.ts');

const candidateEnvPaths = [
  path.join(agentRoot, '.env.local'),
  path.join(agentRoot, '.env'),
  path.join(workspaceRoot, '.env.local'),
  path.join(workspaceRoot, '.env'),
];

const mergedEnv = {};

for (const envPath of candidateEnvPaths) {
  if (!fs.existsSync(envPath)) continue;
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  Object.assign(mergedEnv, parsed);
}

const embeddedConfig = {
  WORKTRACK_SERVER: mergedEnv.WORKTRACK_SERVER || mergedEnv.NEXT_PUBLIC_APP_URL || '',
  NEXT_PUBLIC_APP_URL: mergedEnv.NEXT_PUBLIC_APP_URL || mergedEnv.WORKTRACK_SERVER || '',
  LIVEKIT_URL: mergedEnv.LIVEKIT_URL || '',
  SOCKET_SERVER_URL: mergedEnv.SOCKET_SERVER_URL || mergedEnv.NEXT_PUBLIC_SOCKET_SERVER_URL || '',
  LOCAL_TEST_SERVER_URL: mergedEnv.LOCAL_TEST_SERVER_URL || 'http://localhost:3000',
  VORION_LOCAL_TEST: mergedEnv.VORION_LOCAL_TEST || '',
};

const fileContents = `export const EMBEDDED_ENV = ${JSON.stringify(embeddedConfig, null, 2)} as const;\n`;

fs.writeFileSync(outputPath, fileContents, 'utf8');
console.log('[generate-embedded-config] wrote embedded config', {
  outputPath,
  hasServerUrl: Boolean(embeddedConfig.WORKTRACK_SERVER || embeddedConfig.NEXT_PUBLIC_APP_URL),
  hasLivekitUrl: Boolean(embeddedConfig.LIVEKIT_URL),
});
