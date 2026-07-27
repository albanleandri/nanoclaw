/**
 * Egress lockdown is the container network-isolation control: when it is on,
 * agent containers go on an internal Docker network with the OneCLI gateway
 * attached, and the host must refuse to spawn at all if that cannot be
 * established. The whole value of the module is the fail-closed behaviour, so
 * these tests pin every branch that decides between "return network args" and
 * "throw rather than spawn with open egress".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ execFileSync }));
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));

const NETWORK = 'test-egress-net';
const GATEWAY = 'test-onecli';

async function loadModule(lockdown: boolean) {
  vi.resetModules();
  vi.doMock('./config.js', () => ({
    NANOCLAW_EGRESS_LOCKDOWN: lockdown,
    NANOCLAW_EGRESS_NETWORK: NETWORK,
    ONECLI_GATEWAY_CONTAINER: GATEWAY,
  }));
  return import('./egress-lockdown.js');
}

/** Build an execFileSync stub from a per-subcommand behaviour map. */
function dockerStub(behaviour: {
  inspectNetwork?: 'ok' | 'missing';
  createNetwork?: 'ok' | 'fail';
  connect?: 'ok' | 'fail';
  /** Container names reported attached to the network, in call order. */
  attached?: string[][];
}) {
  const attachedQueue = [...(behaviour.attached ?? [])];
  let lastAttached: string[] = [];
  return vi.fn((_bin: string, args: string[]) => {
    const [group, verb] = args;
    if (group === 'network' && verb === 'inspect') {
      // `network inspect <net>` (existence probe) has no --format flag;
      // the attachment probe passes --format.
      if (!args.includes('--format')) {
        if (behaviour.inspectNetwork === 'missing') throw new Error('no such network');
        return '';
      }
      if (attachedQueue.length) lastAttached = attachedQueue.shift()!;
      return lastAttached.join(' ');
    }
    if (group === 'network' && verb === 'create') {
      if (behaviour.createNetwork === 'fail') throw new Error('cannot create network');
      return '';
    }
    if (group === 'network' && verb === 'connect') {
      if (behaviour.connect === 'fail') throw new Error('cannot connect');
      return '';
    }
    throw new Error(`unexpected docker invocation: ${args.join(' ')}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureEgressNetwork — lockdown disabled', () => {
  it('is a no-op that reports lockdown off and never shells out', async () => {
    const { ensureEgressNetwork } = await loadModule(false);
    execFileSync.mockImplementation(dockerStub({}));

    expect(ensureEgressNetwork()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('ensureEgressNetwork — lockdown enabled', () => {
  it('reuses an existing network with the gateway already attached', async () => {
    const { ensureEgressNetwork } = await loadModule(true);
    execFileSync.mockImplementation(dockerStub({ inspectNetwork: 'ok', attached: [[GATEWAY]] }));

    expect(ensureEgressNetwork()).toBe(true);
    const calls = execFileSync.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(calls.some((c) => c.includes('network connect'))).toBe(false);
  });

  it('creates the network as --internal when it does not exist yet', async () => {
    const { ensureEgressNetwork } = await loadModule(true);
    execFileSync.mockImplementation(
      dockerStub({ inspectNetwork: 'missing', createNetwork: 'ok', attached: [[GATEWAY]] }),
    );

    expect(ensureEgressNetwork()).toBe(true);
    const createCall = execFileSync.mock.calls.find(([, args]) => (args as string[])[1] === 'create');
    expect(createCall?.[1]).toEqual(['network', 'create', '--internal', NETWORK]);
  });

  it('attaches the gateway as host.docker.internal when it is missing from the network', async () => {
    const { ensureEgressNetwork } = await loadModule(true);
    // First attachment probe: empty. After `network connect`, gateway present.
    execFileSync.mockImplementation(dockerStub({ inspectNetwork: 'ok', connect: 'ok', attached: [[], [GATEWAY]] }));

    expect(ensureEgressNetwork()).toBe(true);
    const connectCall = execFileSync.mock.calls.find(([, args]) => (args as string[])[1] === 'connect');
    expect(connectCall?.[1]).toEqual(['network', 'connect', '--alias', 'host.docker.internal', NETWORK, GATEWAY]);
  });

  it('FAILS CLOSED when the internal network can be neither inspected nor created', async () => {
    const { ensureEgressNetwork, EgressLockdownError } = await loadModule(true);
    execFileSync.mockImplementation(dockerStub({ inspectNetwork: 'missing', createNetwork: 'fail' }));

    expect(() => ensureEgressNetwork()).toThrow(EgressLockdownError);
    expect(() => ensureEgressNetwork()).toThrow(/could not be created/);
  });

  it('FAILS CLOSED when the gateway cannot be attached', async () => {
    const { ensureEgressNetwork, EgressLockdownError } = await loadModule(true);
    execFileSync.mockImplementation(dockerStub({ inspectNetwork: 'ok', connect: 'fail', attached: [[], []] }));

    expect(() => ensureEgressNetwork()).toThrow(EgressLockdownError);
    expect(() => ensureEgressNetwork()).toThrow(/could not be attached/);
  });

  it('FAILS CLOSED when connect reports success but the gateway is still not attached', async () => {
    const { ensureEgressNetwork, EgressLockdownError } = await loadModule(true);
    // The post-connect verification is what stops a silently-ineffective
    // connect from being treated as a locked-down network.
    execFileSync.mockImplementation(
      dockerStub({ inspectNetwork: 'ok', connect: 'ok', attached: [[], ['some-other-container']] }),
    );

    expect(() => ensureEgressNetwork()).toThrow(EgressLockdownError);
  });

  it('does not mistake a container whose name contains the gateway name for the gateway', async () => {
    const { ensureEgressNetwork } = await loadModule(true);
    execFileSync.mockImplementation(
      dockerStub({ inspectNetwork: 'ok', connect: 'ok', attached: [[`${GATEWAY}-sidecar`], [GATEWAY]] }),
    );

    // First probe sees only "<gateway>-sidecar" — must NOT count as attached,
    // so the module proceeds to connect the real gateway.
    expect(ensureEgressNetwork()).toBe(true);
    expect(execFileSync.mock.calls.some(([, args]) => (args as string[])[1] === 'connect')).toBe(true);
  });
});

describe('EgressLockdownError', () => {
  it('names the opt-out env var and the gateway container so the operator can act', async () => {
    const { EgressLockdownError } = await loadModule(true);
    const err = new EgressLockdownError('the gateway went missing');

    expect(err.name).toBe('EgressLockdownError');
    expect(err.message).toContain('NANOCLAW_EGRESS_LOCKDOWN=true');
    expect(err.message).toContain('NANOCLAW_EGRESS_LOCKDOWN=false');
    expect(err.message).toContain(GATEWAY);
  });
});

describe('egressNetworkArgs', () => {
  it('pins the agent container to the internal network', async () => {
    const { egressNetworkArgs } = await loadModule(true);
    expect(egressNetworkArgs()).toEqual(['--network', NETWORK]);
  });
});
