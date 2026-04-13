import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
  };
});

import { readEnvFileByPrefix } from './env.js';

describe('readEnvFileByPrefix', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
  });

  it('returns vars matching prefix, excludes others', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'CONTAINER_SECRET_ICAL_URL=https://example.com\nANTHROPIC_API_KEY=secret\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_ICAL_URL: 'https://example.com',
    });
  });

  it('returns multiple vars matching prefix', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'CONTAINER_SECRET_A=foo\nCONTAINER_SECRET_B=bar\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_A: 'foo',
      CONTAINER_SECRET_B: 'bar',
    });
  });

  it('returns empty object when no vars match prefix', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('ANTHROPIC_API_KEY=key\n');
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({});
  });

  it('returns empty object when .env is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({});
  });

  it('strips double quotes from values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'CONTAINER_SECRET_URL="https://example.com"\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_URL: 'https://example.com',
    });
  });

  it('strips single quotes from values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "CONTAINER_SECRET_URL='https://example.com'\n",
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_URL: 'https://example.com',
    });
  });

  it('ignores comment lines', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# CONTAINER_SECRET_IGNORED=value\nCONTAINER_SECRET_REAL=ok\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_REAL: 'ok',
    });
  });

  it('ignores vars with empty values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('CONTAINER_SECRET_EMPTY=\n');
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({});
  });
});
