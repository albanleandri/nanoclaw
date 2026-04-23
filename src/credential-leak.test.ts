import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  OLLAMA_ADMIN_TOOLS: false,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'UTC',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./env.js', () => ({
  readEnvFileByPrefix: vi.fn(() => ({})),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { spawn } from 'child_process';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFileByPrefix } from './env.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'test',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

// spawn is called synchronously in the new Promise executor inside runContainerAgent,
// so args are available immediately after calling runContainerAgent.
function captureSpawnArgs(): string[] {
  return (vi.mocked(spawn).mock.calls[0]?.[1] as string[]) ?? [];
}

async function runAndCapture(): Promise<string[]> {
  const resultPromise = runContainerAgent(
    testGroup,
    testInput,
    () => {},
    vi.fn(),
  );
  const args = captureSpawnArgs();

  const output: ContainerOutput = { status: 'success', result: 'done' };
  fakeProc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
  await vi.advanceTimersByTimeAsync(10);
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  await resultPromise;

  return args;
}

describe('credential leak prevention: container args', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(detectAuthMode).mockReturnValue('api-key');
    vi.mocked(readEnvFileByPrefix).mockReturnValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('auth mode: api-key', () => {
    it('passes ANTHROPIC_API_KEY=placeholder, not a real key', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('api-key');
      const args = await runAndCapture();
      const match = args.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
      expect(match).toBe('ANTHROPIC_API_KEY=placeholder');
    });

    it('does not pass CLAUDE_CODE_OAUTH_TOKEN', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('api-key');
      const args = await runAndCapture();
      expect(args.every((a) => !a.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(
        true,
      );
    });
  });

  describe('auth mode: oauth', () => {
    it('passes CLAUDE_CODE_OAUTH_TOKEN=placeholder, not a real token', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('oauth');
      const args = await runAndCapture();
      const match = args.find((a) => a.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
      expect(match).toBe('CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    });

    it('does not pass ANTHROPIC_API_KEY', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('oauth');
      const args = await runAndCapture();
      expect(args.every((a) => !a.startsWith('ANTHROPIC_API_KEY='))).toBe(true);
    });
  });

  describe('real credential patterns are never present', () => {
    it('no arg contains an Anthropic API key pattern (sk-ant-api*)', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('api-key');
      const args = await runAndCapture();
      for (const arg of args) {
        expect(arg).not.toMatch(/sk-ant-api\d+-/);
      }
    });

    it('no arg contains an Anthropic OAuth token pattern (sk-ant-oat*)', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('oauth');
      const args = await runAndCapture();
      for (const arg of args) {
        expect(arg).not.toMatch(/sk-ant-oat\d+-/);
      }
    });

    it('no arg contains an Anthropic refresh token pattern (sk-ant-ort*)', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('oauth');
      const args = await runAndCapture();
      for (const arg of args) {
        expect(arg).not.toMatch(/sk-ant-ort\d+-/);
      }
    });
  });

  describe('API traffic routing', () => {
    it('ANTHROPIC_BASE_URL routes through credential proxy, not api.anthropic.com', async () => {
      const args = await runAndCapture();
      const baseUrl = args.find((a) => a.startsWith('ANTHROPIC_BASE_URL='));
      expect(baseUrl).toBeDefined();
      expect(baseUrl).not.toContain('api.anthropic.com');
    });

    it('ANTHROPIC_BASE_URL points to a local proxy host and port', async () => {
      const args = await runAndCapture();
      const baseUrl = args.find((a) => a.startsWith('ANTHROPIC_BASE_URL='));
      expect(baseUrl).toMatch(/ANTHROPIC_BASE_URL=http:\/\/.+:\d+/);
    });
  });

  describe('CONTAINER_SECRET_* prefix gate', () => {
    it('env vars with CONTAINER_SECRET_ prefix are forwarded', async () => {
      vi.mocked(readEnvFileByPrefix).mockReturnValue({
        CONTAINER_SECRET_ICAL_URL: 'https://cal.example.com/cal.ics',
      });
      const args = await runAndCapture();
      expect(args).toContain(
        'CONTAINER_SECRET_ICAL_URL=https://cal.example.com/cal.ics',
      );
    });

    it('readEnvFileByPrefix is called with the strict CONTAINER_SECRET_ prefix', async () => {
      await runAndCapture();
      expect(vi.mocked(readEnvFileByPrefix)).toHaveBeenCalledWith(
        'CONTAINER_SECRET_',
      );
    });

    it('TELEGRAM_BOT_TOKEN is never forwarded to containers', async () => {
      // Simulate the prefix gate returning nothing (default mock)
      const args = await runAndCapture();
      expect(args.every((a) => !a.startsWith('TELEGRAM_BOT_TOKEN='))).toBe(
        true,
      );
    });

    it('ONECLI_URL is never forwarded to containers', async () => {
      const args = await runAndCapture();
      expect(args.every((a) => !a.startsWith('ONECLI_URL='))).toBe(true);
    });
  });
});
