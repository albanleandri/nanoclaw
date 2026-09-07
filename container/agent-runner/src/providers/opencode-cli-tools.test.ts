import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'bun:test';

const manifestPath = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');

describe('OpenCode CLI installation', () => {
  it('pins the OpenCode CLI to the SDK-compatible version', () => {
    const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<{ name: string; version: string }>;
    expect(tools).toContainEqual({ name: 'opencode-ai', version: '1.4.17' });
  });
});
