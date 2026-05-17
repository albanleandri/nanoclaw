import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: vi.fn().mockReturnValue({
      next: () => ({ toISOString: () => '2026-01-01T00:00:00.000Z' }),
    }),
  },
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

vi.mock('./channels/telegram.js', () => ({
  sendPoolMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  IPC_POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
}));

describe('IpcDeps.askUser contract', () => {
  it('IpcDeps interface accepts optional askUser function', () => {
    const deps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      askUser: vi.fn(),
    };
    expect(typeof deps.askUser).toBe('function');
  });
});
