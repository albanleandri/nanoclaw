import fs from 'fs';

import { describe, expect, it } from 'vitest';

describe('RTK container installation contract', () => {
  const dockerfile = fs.readFileSync('container/Dockerfile', 'utf8');

  it('pins RTK 0.43.0 with architecture-specific assets and checksums', () => {
    expect(dockerfile).toContain('ARG RTK_VERSION=0.43.0');
    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain('rtk-x86_64-unknown-linux-musl.tar.gz');
    expect(dockerfile).toContain('rtk-aarch64-unknown-linux-gnu.tar.gz');
    expect(dockerfile).toContain('ff8a1e7766496e175291a85aeca1dc97c9ff6df33e51e5893d1fbc78fea2a609');
    expect(dockerfile).toContain('5519f7ca12e5c143a609f0d28a0a77b97413a8dce31c2681f1a41c24519a8731');
    expect(dockerfile).toContain('sha256sum -c -');
  });

  it('verifies the installed RTK binary during the image build', () => {
    expect(dockerfile).toContain('rtk --version');
    expect(dockerfile).toContain('rtk gain');
  });
});
