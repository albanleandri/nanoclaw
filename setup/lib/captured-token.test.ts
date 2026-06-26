import { describe, expect, it } from 'vitest';

import { extractClaudeOAuthToken } from './captured-token.js';

const TOKEN = `sk-ant-oat01-${'a'.repeat(90)}AA`;

describe('extractClaudeOAuthToken', () => {
  it('extracts the token from clean single-line output', () => {
    expect(extractClaudeOAuthToken(`Login successful.\n${TOKEN}\n`)).toBe(TOKEN);
  });

  it('extracts a wrapped token from PTY capture and ignores the placeholder export', () => {
    const head = TOKEN.slice(0, 72);
    const tail = TOKEN.slice(72);
    const raw = `
\x1b[?2026hYour OAuth token:

  ${head}
  ${tail}

Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
`;
    expect(extractClaudeOAuthToken(raw)).toBe(TOKEN);
  });

  it('returns null for the placeholder env-var line', () => {
    expect(extractClaudeOAuthToken('export CLAUDE_CODE_OAUTH_TOKEN=<token>\n')).toBeNull();
  });

  it('returns null when no token is present', () => {
    expect(extractClaudeOAuthToken('claude: authentication cancelled\n')).toBeNull();
  });
});
