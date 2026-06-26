/**
 * Egress lockdown forces agent traffic through the OneCLI gateway by placing
 * agent containers on an internal Docker network with the gateway attached as
 * host.docker.internal.
 */
import { execFileSync } from 'child_process';

import { NANOCLAW_EGRESS_LOCKDOWN, NANOCLAW_EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

export const EGRESS_NETWORK = NANOCLAW_EGRESS_NETWORK;

export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Start the OneCLI gateway container ` +
        `"${ONECLI_GATEWAY_CONTAINER}", or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function gatewayAttached(): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15_000 },
    );
    return out.split(/\s+/).includes(ONECLI_GATEWAY_CONTAINER);
  } catch {
    return false;
  }
}

export function ensureEgressNetwork(): boolean {
  if (!NANOCLAW_EGRESS_LOCKDOWN) return false;

  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached()) return true;

  if (
    dockerOk(['network', 'connect', '--alias', 'host.docker.internal', EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER]) &&
    gatewayAttached()
  ) {
    log.info('Egress lockdown: OneCLI gateway attached', {
      network: EGRESS_NETWORK,
      gateway: ONECLI_GATEWAY_CONTAINER,
    });
    return true;
  }

  throw new EgressLockdownError(
    `the OneCLI gateway "${ONECLI_GATEWAY_CONTAINER}" could not be attached to "${EGRESS_NETWORK}"`,
  );
}

export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
