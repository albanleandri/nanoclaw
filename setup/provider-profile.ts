/**
 * Step: provider-profile — create and optionally verify a generic endpoint
 * profile before the first group is registered.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createProviderProfile, setProviderProfileEnabled } from '../src/db/provider-profiles.js';
import { verifyProviderProfile } from '../src/providers/provider-verifier-registry.js';
import { emitStatus } from './status.js';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function run(args: string[]): Promise<void> {
  const name = value(args, '--name');
  const baseUrl = value(args, '--base-url');
  const apiFamily = value(args, '--api-family') as 'responses' | 'chat-completions' | undefined;
  const model = value(args, '--model');
  const authMode = value(args, '--auth-mode') as 'onecli-secret' | 'none' | undefined;
  const authRef = value(args, '--auth-ref');
  const agentGroupId = value(args, '--agent-group-id');
  if (!name || !baseUrl || !apiFamily || !model || !authMode) {
    throw new Error('--name, --base-url, --api-family, --model, and --auth-mode are required');
  }

  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const profile = createProviderProfile({
    name,
    providerName: 'openai-compatible',
    baseUrl,
    apiFamily,
    defaultModel: model,
    authMode,
    authRef,
    allowInsecureHttp: args.includes('--allow-insecure-http'),
  });
  const verification = args.includes('--verify') ? await verifyProviderProfile(profile, { agentGroupId }) : undefined;
  if (verification && !verification.ok) {
    setProviderProfileEnabled(profile.id, false);
    emitStatus('PROVIDER_PROFILE', {
      STATUS: 'failed',
      PROFILE_ID: profile.id,
      ERROR: verification.classification ?? 'verification_failed',
      HINT: verification.hint ?? '',
    });
    throw new Error(verification.hint || 'Provider verification failed');
  }
  emitStatus('PROVIDER_PROFILE', {
    STATUS: 'success',
    PROFILE_ID: profile.id,
    PROFILE_NAME: profile.name,
    PROVIDER: profile.provider_name,
    VERIFIED: verification?.ok ?? false,
  });
}
