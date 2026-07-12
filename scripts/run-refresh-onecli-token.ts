#!/usr/bin/env tsx
import os from 'os';
import path from 'path';
import { refreshOnecliToken } from '../src/onecli-token-refresh.js';
import { CLAUDE_ONECLI_SECRET_ID, ONECLI_URL } from '../src/config.js';

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const SECRET_ID = CLAUDE_ONECLI_SECRET_ID;

const onecliUrl = ONECLI_URL ?? 'http://172.17.0.1:10254';

try {
  if (!SECRET_ID) throw new Error('CLAUDE_ONECLI_SECRET_ID is not configured');
  await refreshOnecliToken({ credentialsPath: CREDENTIALS_PATH, onecliUrl, secretId: SECRET_ID });
  console.log(`[refresh-onecli-token] OK: OneCLI secret ${SECRET_ID} updated`);
} catch (err) {
  console.error(`[refresh-onecli-token] ERROR: ${(err as Error).message}`);
  process.exit(1);
}
