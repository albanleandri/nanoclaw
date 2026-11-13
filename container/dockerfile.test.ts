import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const fullDockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8').replace(/^\s*#.*$/gm, '');
const dockerfile = fullDockerfile.slice(fullDockerfile.indexOf('FROM node:'));

function baseAptPackages(): string[] {
  const block = dockerfile.match(/apt-get install -y --no-install-recommends([^&]*)&&/);
  if (!block) throw new Error('base apt-get install list not found in container/Dockerfile');
  return block[1].split(/[\s\\]+/).filter(Boolean);
}

describe('container/Dockerfile system packages', () => {
  it('installs poppler-utils for PDF text and image extraction', () => {
    expect(baseAptPackages()).toContain('poppler-utils');
  });
});
