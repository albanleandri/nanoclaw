/**
 * Step: provider-auth — verify or register non-Claude provider credentials.
 *
 * Codex supports two local auth paths here:
 * - OpenAI API key through this repository's OneCLI 1.4.x generic secret API.
 * - ChatGPT subscription by explicitly opting into copying the host Codex
 *   auth.json into each Codex group's private state directory.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';

import { log } from '../src/log.js';
import { writePrivateFileSync } from '../src/private-files.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

type Mode = 'check' | 'api-key' | 'chatgpt';

interface Args {
  provider: string;
  mode: Mode;
  value?: string;
  force: boolean;
}

interface OnecliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern?: string | null;
  pathPattern?: string | null;
}

interface CodexAuthJson {
  auth_mode?: string;
  tokens?: { access_token?: string; refresh_token?: string };
  OPENAI_API_KEY?: string | null;
}

const HOST_CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const CODEX_AUTH_MODE = 'host-file';

function readCodexAuthJson(authPath: string): CodexAuthJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf-8')) as CodexAuthJson;
  } catch {
    return undefined;
  }
}

function isChatGptAuth(auth: CodexAuthJson | undefined): boolean {
  return auth?.auth_mode === 'chatgpt' && !!auth.tokens?.access_token && !!auth.tokens?.refresh_token;
}

function upsertEnvValue(key: string, value: string): boolean {
  const envFile = path.join(process.cwd(), '.env');
  let content = '';
  if (fs.existsSync(envFile)) content = fs.readFileSync(envFile, 'utf-8');

  const lineRegex = new RegExp('^' + key + '=.*$', 'm');
  const newLine = key + '=' + value;
  const existed = lineRegex.test(content);
  if (existed) {
    content = content.replace(lineRegex, newLine);
  } else {
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    content = content + sep + newLine + '\n';
  }
  writePrivateFileSync(envFile, content);
  return existed;
}

function isCodexChatGptAuthEnabled(): boolean {
  if (process.env.CODEX_CHATGPT_AUTH === CODEX_AUTH_MODE) return true;
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return false;
  return fs
    .readFileSync(envFile, 'utf-8')
    .split('\n')
    .some((line) => line.trim() === 'CODEX_CHATGPT_AUTH=' + CODEX_AUTH_MODE);
}

function seedExistingCodexAuthFiles(): number {
  const sessionsRoot = path.join(process.cwd(), 'data', 'v2-sessions');
  if (!fs.existsSync(sessionsRoot)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(sessionsRoot)) {
    const codexDir = path.join(sessionsRoot, entry, '.codex-shared');
    if (!fs.existsSync(codexDir)) continue;
    fs.mkdirSync(codexDir, { recursive: true });
    const dest = path.join(codexDir, 'auth.json');
    fs.copyFileSync(HOST_CODEX_AUTH_PATH, dest);
    fs.chmodSync(dest, 0o600);
    count++;
  }
  return count;
}

function enableCodexChatGptAuth(): { envExisted: boolean; seeded: number } {
  const auth = readCodexAuthJson(HOST_CODEX_AUTH_PATH);
  if (!isChatGptAuth(auth)) {
    emitStatus('PROVIDER_AUTH', {
      PROVIDER: 'codex',
      STATUS: 'failed',
      ERROR: 'host_codex_chatgpt_auth_missing',
      HINT: 'Run `codex login -c \'cli_auth_credentials_store="file"\' --device-auth` on the host, then re-run provider-auth codex --chatgpt.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const envExisted = upsertEnvValue('CODEX_CHATGPT_AUTH', CODEX_AUTH_MODE);
  const seeded = seedExistingCodexAuthFiles();
  return { envExisted, seeded };
}

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function parseArgs(args: string[]): Args {
  const provider = args[0] && !args[0].startsWith('--') ? args[0] : '';
  let mode: Mode = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = provider ? 1 : 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--api-key':
        mode = 'api-key';
        value = val;
        i++;
        break;
      case '--chatgpt':
        mode = 'chatgpt';
        break;
      case '--force':
        force = true;
        break;
    }
  }

  return { provider, mode, value, force };
}

function ensureCodexProvider(provider: string): void {
  if (provider !== 'codex') {
    emitStatus('PROVIDER_AUTH', {
      STATUS: 'failed',
      ERROR: provider ? `unsupported_provider:${provider}` : 'missing_provider',
      HINT: 'Usage: pnpm exec tsx setup/index.ts --step provider-auth codex [--check|--api-key <sk-...>]',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }
}

function parseSecretsOutput(raw: string): OnecliSecret[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as OnecliSecret[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: unknown[] }).data as OnecliSecret[];
  }
  return [];
}

function listSecrets(): OnecliSecret[] {
  const out = execFileSync('onecli', ['secrets', 'list'], {
    encoding: 'utf-8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseSecretsOutput(out);
}

function findCodexSecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => {
    const name = s.name.toLowerCase();
    const host = (s.hostPattern ?? '').toLowerCase();
    return (
      name === 'codex' || name.includes('openai') || host.includes('api.openai.com') || host.includes('chatgpt.com')
    );
  });
}

function createCodexApiKeySecret(key: string): void {
  execFileSync(
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      'Codex',
      '--type',
      'generic',
      '--value',
      key,
      '--host-pattern',
      'api.openai.com',
      '--path-pattern',
      '/v1/*',
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    ],
    { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

async function promptForApiKey(): Promise<string> {
  const answer = await p.password({
    message: 'Paste your OpenAI API key for Codex (sk-...)',
    validate: (v) => (v && v.trim().startsWith('sk-') ? undefined : 'That does not look like an OpenAI API key.'),
  });
  if (p.isCancel(answer)) {
    p.cancel('Codex auth cancelled.');
    process.exit(1);
  }
  return String(answer).trim();
}

async function chooseMode(): Promise<Mode> {
  const answer = await p.select<Mode>({
    message: 'How should Codex authenticate?',
    options: [
      { value: 'api-key', label: 'OpenAI API key', hint: 'works with this OneCLI install' },
      { value: 'check', label: 'Check existing auth only' },
      { value: 'chatgpt', label: 'ChatGPT subscription', hint: 'uses the host Codex auth file' },
    ],
    initialValue: 'api-key',
  });
  if (p.isCancel(answer)) {
    p.cancel('Codex auth cancelled.');
    process.exit(1);
  }
  return answer;
}

function emitCheck(existing: OnecliSecret | undefined): void {
  const chatGptEnabled = isCodexChatGptAuthEnabled() && isChatGptAuth(readCodexAuthJson(HOST_CODEX_AUTH_PATH));
  const ok = !!existing || chatGptEnabled;
  emitStatus('PROVIDER_AUTH', {
    PROVIDER: 'codex',
    SECRET_PRESENT: !!existing,
    CHATGPT_AUTH_ENABLED: chatGptEnabled,
    CODEX_OK: ok,
    STATUS: ok ? 'success' : 'missing',
    ...(existing
      ? { SECRET_NAME: existing.name, SECRET_ID: existing.id, HOST_PATTERN: existing.hostPattern ?? '' }
      : {}),
    HINT: ok
      ? ''
      : 'Run: codex login -c \'cli_auth_credentials_store="file"\' --device-auth, then pnpm exec tsx setup/index.ts --step provider-auth codex --chatgpt. Or use --api-key OPENAI_API_KEY.',
    LOG: 'logs/setup.log',
  });
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  ensureCodexProvider(parsed.provider);

  let mode = parsed.mode;
  if (args.length === 1) mode = await chooseMode();

  let secrets: OnecliSecret[];
  try {
    secrets = listSecrets();
  } catch (err) {
    log.error('onecli secrets list failed for Codex provider auth', { err });
    emitStatus('PROVIDER_AUTH', {
      PROVIDER: 'codex',
      STATUS: 'failed',
      ERROR: 'onecli_list_failed',
      HINT: 'Is OneCLI running? Start it, then retry provider-auth codex.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const existing = findCodexSecret(secrets);
  if (mode === 'check') {
    emitCheck(existing);
    return;
  }

  if (mode === 'chatgpt') {
    const enabled = enableCodexChatGptAuth();
    emitStatus('PROVIDER_AUTH', {
      PROVIDER: 'codex',
      STATUS: 'success',
      CHATGPT_AUTH_ENABLED: true,
      ENV_KEY: 'CODEX_CHATGPT_AUTH',
      ENV_EXISTED: enabled.envExisted,
      SEEDED_CODEX_AUTH_FILES: enabled.seeded,
      HINT: 'Rebuild the agent container for the updated Codex CLI pin, restart NanoClaw, then send a fresh Codex message.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (existing && !parsed.force) {
    emitStatus('PROVIDER_AUTH', {
      PROVIDER: 'codex',
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'codex_secret_already_exists',
      SECRET_NAME: existing.name,
      SECRET_ID: existing.id,
      HINT: 'Delete the existing Codex/OpenAI secret first, or re-run with --force after deleting it.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const key = parsed.value ?? (await promptForApiKey());
  try {
    createCodexApiKeySecret(key.trim());
  } catch (err) {
    const e = err as { stderr?: string | Buffer; status?: number };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? '');
    log.error('onecli secrets create failed for Codex provider auth', { status: e.status, stderr });
    emitStatus('PROVIDER_AUTH', {
      PROVIDER: 'codex',
      STATUS: 'failed',
      ERROR: 'onecli_create_failed',
      EXIT_CODE: e.status ?? -1,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  emitCheck(findCodexSecret(listSecrets()));
}
