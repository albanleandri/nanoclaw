import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Parses .env lines into key/value pairs, ignoring comments and blanks.
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const envPath = path.join(process.cwd(), '.env');
const envExists = fs.existsSync(envPath);
const envContent = envExists ? fs.readFileSync(envPath, 'utf-8') : '';
const env = parseEnvFile(envContent);

describe.skipIf(!envExists)('credential-env: .env does not contain raw credentials', () => {
  it('ANTHROPIC_API_KEY is absent from .env', () => {
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('CLAUDE_CODE_OAUTH_TOKEN is absent from .env', () => {
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('ANTHROPIC_AUTH_TOKEN is absent from .env', () => {
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('no .env value contains a raw Anthropic API key (sk-ant-api*)', () => {
    for (const [key, value] of Object.entries(env)) {
      expect({ key, value }).not.toMatchObject({
        value: expect.stringMatching(/sk-ant-api\d+-/),
      });
    }
  });

  it('no .env value contains a raw Anthropic OAuth token (sk-ant-oat*)', () => {
    for (const [key, value] of Object.entries(env)) {
      expect({ key, value }).not.toMatchObject({
        value: expect.stringMatching(/sk-ant-oat\d+-/),
      });
    }
  });
});

describe.skipIf(!envExists)('credential-env: OneCLI gateway is configured', () => {
  it('ONECLI_URL is set in .env', () => {
    expect(env).toHaveProperty('ONECLI_URL');
    expect(env['ONECLI_URL']).toMatch(/^http:\/\/.+:\d+/);
  });
});

describe.skipIf(!envExists)('credential-env: required secrets are preserved', () => {
  it('CONTAINER_SECRET_PROTON_ICAL_URL is present in .env', () => {
    expect(env).toHaveProperty('CONTAINER_SECRET_PROTON_ICAL_URL');
    expect(env['CONTAINER_SECRET_PROTON_ICAL_URL']).toBeTruthy();
  });
});
