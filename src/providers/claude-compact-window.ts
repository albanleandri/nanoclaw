/**
 * Pass the operator's CLAUDE_CODE_AUTO_COMPACT_WINDOW into Claude containers
 * (ported from upstream 6a82c287).
 *
 * The agent-runner reads the override from the container env, which the host
 * builds from scratch, so a value set in the service env or `.env` never
 * arrived. This is deliberately not part of `./claude.js`: importing that file
 * is how setup turns on the custom-endpoint ANTHROPIC_BASE_URL passthrough.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

export function claudeCompactWindowEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const value = hostEnv[KEY]?.trim() || readEnvFile([KEY])[KEY]?.trim();
  if (!value) return {};
  if (!/^[1-9]\d*$/.test(value)) {
    log.warn(`Ignoring ${KEY}: expected a positive integer token count`, { value });
    return {};
  }
  return { [KEY]: value };
}
