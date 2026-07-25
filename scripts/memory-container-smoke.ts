import fs from 'node:fs';

import { ensureMemoryScaffold, renderMemoryContext } from '../container/agent-runner/src/memory/index.js';
import type { RunnerAgentProfile } from '../container/agent-runner/src/config.js';

const root = '/workspace/agent/memory';
const profile: RunnerAgentProfile['memory'] = {
  workspacePath: '/workspace/agent',
  localMemoryFile: 'CLAUDE.local.md',
  neutralMemoryRoot: root,
  indexPath: 'index.md',
  definitionPath: 'system/definition.md',
  conversationsPath: '/workspace/agent/conversations',
  mode: 'shadow',
  access: 'read-write',
  okfVersion: '0.1',
  indexMaxBytes: 12 * 1024,
  definitionMaxBytes: 8 * 1024,
  renderedMaxBytes: 24 * 1024,
};

ensureMemoryScaffold(profile);
const index = `${root}/index.md`;
const initial = fs.readFileSync(index, 'utf8');
fs.writeFileSync(
  index,
  initial.replace('No durable facts have been recorded yet.', 'Container smoke fact: color is blue.'),
);
const remembered = renderMemoryContext(profile).context;
if (!remembered.includes('Container smoke fact: color is blue.')) throw new Error('remember/recall smoke failed');

fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('color is blue', 'color is green'));
const corrected = renderMemoryContext(profile).context;
if (!corrected.includes('color is green') || corrected.includes('color is blue')) {
  throw new Error('correction/fresh-render smoke failed');
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    checks: ['scaffold', 'remember', 'fresh-render-recall', 'correct', 'fresh-render-correction'],
  })}\n`,
);
