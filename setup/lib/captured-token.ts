import fs from 'fs';
import { pathToFileURL } from 'url';

// Control characters are the subject of these patterns, not an accident:
// captured terminal output has to be stripped of CSI sequences and control
// bytes before a token can be read out of it.
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_AND_SPACE = /[\x00-\x20\x7f]/g;
const CLAUDE_OAUTH_TOKEN = /sk-ant-oat[A-Za-z0-9_-]{80,500}AA/g;

function normalizeCapturedTerminalOutput(raw: string): string {
  return raw.replace(CSI, '').replace(CONTROL_AND_SPACE, '');
}

export function extractClaudeOAuthToken(raw: string): string | null {
  const matches = normalizeCapturedTerminalOutput(raw).match(CLAUDE_OAUTH_TOKEN);
  return matches ? matches[matches.length - 1] : null;
}

function runCli(argv: string[]): number {
  const [provider, file] = argv;
  if (provider !== 'claude' || !file) {
    process.stderr.write('usage: captured-token.ts claude <capture-file>\n');
    return 2;
  }
  const token = extractClaudeOAuthToken(fs.readFileSync(file, 'utf-8'));
  if (!token) return 1;
  process.stdout.write(token);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runCli(process.argv.slice(2)));
}
