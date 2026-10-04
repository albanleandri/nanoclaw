import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialStoreError, createCredentialRef, parseCredentialRef } from './credential-store.js';
import { LocalFileCredentialStore } from './local-file-credential-store.js';

let dataDir: string;
let store: LocalFileCredentialStore;

function storageDirectory(): string {
  return path.join(dataDir, 'private-integrations', 'v1');
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-credential-store-'));
  store = new LocalFileCredentialStore({ dataDir });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function onlyStagePath(): string {
  const names = fs.readdirSync(storageDirectory()).filter((name) => name.includes('.stage-'));
  expect(names).toHaveLength(1);
  return path.join(storageDirectory(), names[0]!);
}

describe('local file credential store', () => {
  it('stages and atomically promotes an owner-only JSON object', async () => {
    const ref = createCredentialRef();
    const staged = await store.stage(ref, { username: 'person', password: 'sentinel' });

    expect(await store.status(ref)).toBe('missing');
    expect(fs.statSync(path.join(dataDir, 'private-integrations')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(storageDirectory()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(onlyStagePath()).mode & 0o777).toBe(0o600);

    await store.promote(staged);

    expect(await store.status(ref)).toBe('available');
    expect(await store.read(ref)).toEqual({ username: 'person', password: 'sentinel' });
    expect(fs.readdirSync(storageDirectory())).toEqual([`${ref}.json`]);
  });

  it('keeps the old credential active until a validated candidate is promoted', async () => {
    const ref = createCredentialRef();
    await store.promote(await store.stage(ref, { password: 'old' }));
    const replacement = await store.stage(ref, { password: 'new' });

    expect(await store.read(ref)).toEqual({ password: 'old' });
    fs.chmodSync(onlyStagePath(), 0o644);
    await expect(store.promote(replacement)).rejects.toMatchObject({ code: 'unsafe' });
    expect(await store.read(ref)).toEqual({ password: 'old' });
  });

  it('supports explicit staging discard without affecting the active credential', async () => {
    const ref = createCredentialRef();
    await store.promote(await store.stage(ref, { password: 'active' }));
    const staged = await store.stage(ref, { password: 'discarded' });

    await store.discard(staged);

    expect(await store.read(ref)).toEqual({ password: 'active' });
    expect(fs.readdirSync(storageDirectory())).toEqual([`${ref}.json`]);
    await expect(store.discard(staged)).rejects.toMatchObject({ code: 'invalid_stage' });
  });

  it('revokes only the exact generated credential and is idempotent when it is absent', async () => {
    const first = createCredentialRef();
    const second = createCredentialRef();
    await store.promote(await store.stage(first, { password: 'first' }));
    await store.promote(await store.stage(second, { password: 'second' }));

    await store.revoke(first);
    await store.revoke(first);

    expect(await store.status(first)).toBe('missing');
    expect(await store.read(second)).toEqual({ password: 'second' });
  });

  it('distinguishes missing credentials from unsafe storage', async () => {
    const ref = createCredentialRef();
    expect(await store.status(ref)).toBe('missing');
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'missing' });

    fs.mkdirSync(path.join(dataDir, 'private-integrations'), { mode: 0o755 });
    expect(await store.status(ref)).toBe('unsafe');
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('rejects traversal and arbitrary filenames before filesystem access', async () => {
    expect(() => parseCredentialRef('../../etc/passwd')).toThrowError(
      expect.objectContaining<Partial<CredentialStoreError>>({ code: 'invalid_reference' }),
    );
    await expect(store.status('../../etc/passwd' as never)).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it('rejects symlinked storage directories and credential files', async () => {
    const ref = createCredentialRef();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-credential-outside-'));
    try {
      fs.symlinkSync(outside, path.join(dataDir, 'private-integrations'));
      await expect(store.stage(ref, { password: 'sentinel' })).rejects.toMatchObject({ code: 'unsafe' });
      fs.unlinkSync(path.join(dataDir, 'private-integrations'));

      const staged = await store.stage(ref, { password: 'sentinel' });
      await store.promote(staged);
      const active = path.join(storageDirectory(), `${ref}.json`);
      fs.unlinkSync(active);
      fs.writeFileSync(path.join(outside, 'target.json'), '{"password":"outside"}\n', { mode: 0o600 });
      fs.symlinkSync(path.join(outside, 'target.json'), active);
      expect(await store.status(ref)).toBe('unsafe');
      await expect(store.read(ref)).rejects.toMatchObject({ code: 'unsafe' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects hard-linked files and group/other permission bits', async () => {
    const ref = createCredentialRef();
    await store.promote(await store.stage(ref, { password: 'sentinel' }));
    const active = path.join(storageDirectory(), `${ref}.json`);
    const linked = path.join(dataDir, 'linked-copy');
    fs.linkSync(active, linked);

    expect(await store.status(ref)).toBe('unsafe');
    await expect(store.revoke(ref)).rejects.toMatchObject({ code: 'unsafe' });
    expect(fs.existsSync(active)).toBe(true);

    fs.unlinkSync(linked);
    fs.chmodSync(active, 0o640);
    expect(await store.status(ref)).toBe('unsafe');
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('rejects malformed, non-object, empty, and oversized stored payloads', async () => {
    const ref = createCredentialRef();
    await store.promote(await store.stage(ref, { password: 'valid' }));
    const active = path.join(storageDirectory(), `${ref}.json`);

    for (const malformed of ['not json', '[]', '']) {
      fs.writeFileSync(active, malformed, { mode: 0o600 });
      expect(await store.status(ref)).toBe('unsafe');
      await expect(store.read(ref)).rejects.toMatchObject({ code: 'unsafe' });
    }

    const smallStore = new LocalFileCredentialStore({ dataDir, maxPayloadBytes: 32 });
    await expect(smallStore.stage(createCredentialRef(), { password: 'x'.repeat(100) })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('never includes a rejected credential value in store errors', async () => {
    const sentinel = 'SENTINEL_SECRET_VALUE';
    const cyclic: Record<string, unknown> = { password: sentinel };
    cyclic.self = cyclic;

    const error = await store.stage(createCredentialRef(), cyclic).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect(String(error)).not.toContain(sentinel);
  });

  it('rejects forged and cross-store staged handles', async () => {
    const staged = await store.stage(createCredentialRef(), { password: 'sentinel' });
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-other-store-'));
    const other = new LocalFileCredentialStore({ dataDir: otherRoot });
    try {
      await expect(other.promote(staged)).rejects.toMatchObject({ code: 'invalid_stage' });
      await expect(store.promote({ token: 'forged' })).rejects.toMatchObject({ code: 'invalid_stage' });
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
