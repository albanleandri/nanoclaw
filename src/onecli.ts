import { OneCLI, OneCLIRequestError, type ContainerConfig } from '@onecli-sh/sdk';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { combinedCaBundle, stageOneCliFile } from './onecli-files.js';

export interface OneCliGatewayConfig {
  url: string;
  apiKey?: string;
}

export function getOneCliGatewayConfig(): OneCliGatewayConfig | null {
  const envConfig = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  const url = process.env.ONECLI_URL || envConfig.ONECLI_URL;
  if (!url) return null;

  return {
    url,
    apiKey: process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY,
  };
}

export function isOneCliConfigured(): boolean {
  return getOneCliGatewayConfig() !== null;
}

export interface ApplyOneCliContainerConfigOptions {
  addHostMapping?: boolean;
  client?: OneCLI;
  dataDir?: string;
}

function applyPersistentFiles(args: string[], config: ContainerConfig, dataDir: string): void {
  for (const [key, value] of Object.entries(config.env)) args.push('-e', `${key}=${value}`);
  args.push('-v', `${stageOneCliFile(dataDir, 'ca', config.caCertificate)}:${config.caCertificateContainerPath}:ro`);

  const combined = combinedCaBundle(config.caCertificate);
  if (combined !== undefined) {
    const containerPath = '/tmp/onecli-combined-ca.pem';
    args.push('-e', `SSL_CERT_FILE=${containerPath}`, '-e', `DENO_CERT=${containerPath}`);
    args.push('-v', `${stageOneCliFile(dataDir, 'combined', combined)}:${containerPath}:ro`);
  }
  for (const stub of config.credentialStubs ?? []) {
    args.push('-v', `${stageOneCliFile(dataDir, 'stub', stub.content)}:${stub.containerPath}:ro`);
  }
}

export async function applyOneCliContainerConfig(
  args: string[],
  agent: string,
  options: ApplyOneCliContainerConfigOptions = {},
): Promise<boolean> {
  const config = getOneCliGatewayConfig();
  if (!config) return false;

  const onecli = options.client ?? new OneCLI({ url: config.url, apiKey: config.apiKey });
  let containerConfig: ContainerConfig;
  try {
    containerConfig = await onecli.getContainerConfig({ agent });
  } catch (error) {
    if (error instanceof OneCLIRequestError && error.statusCode >= 400 && error.statusCode < 500) throw error;
    return false;
  }

  applyPersistentFiles(args, containerConfig, options.dataDir ?? DATA_DIR);
  if ((options.addHostMapping ?? true) && process.platform === 'linux') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  return true;
}
