import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { lookup } from '../registry.js';
import './providers.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('provider CLI resources', () => {
  it('lists installed descriptors without profile credentials', async () => {
    const command = lookup('providers-list')!;
    const result = (await command.handler({}, { caller: 'host' })) as Array<Record<string, unknown>>;
    expect(result.map((item) => item.name)).toEqual(['claude', 'codex', 'mock', 'openai-compatible']);
  });

  it('creates and lists a redacted generic profile', async () => {
    const create = lookup('providers-create-openai-compatible')!;
    const created = (await create.handler(
      {
        name: 'test-profile',
        base_url: 'https://example.test/v1',
        api_family: 'responses',
        model: 'test-model',
        auth_mode: 'onecli-secret',
        auth_ref: 'Secret Name',
      },
      { caller: 'host' },
    )) as Record<string, unknown>;
    expect(created).toMatchObject({ name: 'test-profile', auth_configured: true });
    expect(created).not.toHaveProperty('auth_ref');

    const profiles = lookup('providers-profiles')!;
    const rows = (await profiles.handler({}, { caller: 'host' })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('Secret Name');
  });

  it('registers an approval-gated tool verification command', () => {
    expect(lookup('providers-verify-tools')).toMatchObject({ access: 'approval' });
  });
});
