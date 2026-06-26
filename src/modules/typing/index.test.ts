import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const heartbeatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-typing-test-'));

vi.mock('../../session-manager.js', () => ({
  heartbeatPath: (agentGroupId: string, sessionId: string) =>
    path.join(heartbeatRoot, agentGroupId, `${sessionId}.heartbeat`),
}));

const {
  pauseTypingRefreshAfterDelivery,
  resetTypingForTests,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} = await import('./index.js');

function touchHeartbeat(agentGroupId: string, sessionId: string): void {
  const hbPath = path.join(heartbeatRoot, agentGroupId, `${sessionId}.heartbeat`);
  fs.mkdirSync(path.dirname(hbPath), { recursive: true });
  fs.writeFileSync(hbPath, '');
  fs.utimesSync(hbPath, new Date(Date.now()), new Date(Date.now()));
}

describe('typing refresh UX', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTypingForTests();
    fs.rmSync(heartbeatRoot, { recursive: true, force: true });
    fs.mkdirSync(heartbeatRoot, { recursive: true });
  });

  afterEach(() => {
    resetTypingForTests();
    vi.useRealTimers();
  });

  it('sets typing immediately and refreshes during the startup grace window', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });

    startTypingRefresh('session-1', 'agent-group-1', 'telegram', '12345', null);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenLastCalledWith('telegram', '12345', null);

    await vi.advanceTimersByTimeAsync(4000);

    expect(setTyping).toHaveBeenCalledTimes(2);
  });

  it('sends one long-wait status while the user is still waiting', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const sendStatus = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping, sendStatus });

    startTypingRefresh('session-2', 'agent-group-1', 'telegram', '12345', null);
    await vi.advanceTimersByTimeAsync(28000);

    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus).toHaveBeenCalledWith('telegram', '12345', null, 'Working on it...');

    await vi.advanceTimersByTimeAsync(20000);

    expect(sendStatus).toHaveBeenCalledTimes(1);
  });

  it('does not send waiting status after a user-facing reply has landed', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const sendStatus = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping, sendStatus });

    startTypingRefresh('session-3', 'agent-group-1', 'telegram', '12345', null);
    await vi.advanceTimersByTimeAsync(12000);
    pauseTypingRefreshAfterDelivery('session-3');
    await vi.advanceTimersByTimeAsync(200000);

    expect(sendStatus).not.toHaveBeenCalled();
  });

  it('resets waiting notices when a new inbound message restarts an active refresher', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const sendStatus = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping, sendStatus });

    startTypingRefresh('session-4', 'agent-group-1', 'telegram', '12345', null);
    await vi.advanceTimersByTimeAsync(28000);

    expect(sendStatus).toHaveBeenCalledTimes(1);

    startTypingRefresh('session-4', 'agent-group-1', 'telegram', '12345', null);
    await vi.advanceTimersByTimeAsync(28000);

    expect(sendStatus).toHaveBeenCalledTimes(2);
  });

  it('continues refreshing after startup only while heartbeat remains fresh', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });

    startTypingRefresh('session-5', 'agent-group-1', 'telegram', '12345', null);
    await vi.advanceTimersByTimeAsync(28000);

    touchHeartbeat('agent-group-1', 'session-5');
    await vi.advanceTimersByTimeAsync(4000);

    expect(setTyping).toHaveBeenCalledTimes(9);

    await vi.advanceTimersByTimeAsync(8000);
    const callsAfterStaleHeartbeat = setTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);

    expect(setTyping).toHaveBeenCalledTimes(callsAfterStaleHeartbeat);
  });

  it('sends one still-working status for very long active work', async () => {
    const sendStatus = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping: vi.fn().mockResolvedValue(undefined), sendStatus });

    startTypingRefresh('session-6', 'agent-group-1', 'telegram', '12345', null);

    for (let elapsed = 0; elapsed < 184000; elapsed += 4000) {
      touchHeartbeat('agent-group-1', 'session-6');
      await vi.advanceTimersByTimeAsync(4000);
    }

    expect(sendStatus).toHaveBeenCalledTimes(2);
    expect(sendStatus).toHaveBeenNthCalledWith(1, 'telegram', '12345', null, 'Working on it...');
    expect(sendStatus).toHaveBeenNthCalledWith(2, 'telegram', '12345', null, 'Still working...');

    await vi.advanceTimersByTimeAsync(12000);

    expect(sendStatus).toHaveBeenCalledTimes(2);
    stopTypingRefresh('session-6');
  });
});
