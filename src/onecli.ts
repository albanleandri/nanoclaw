import { OneCLI } from '@onecli-sh/sdk';

import { readEnvFile } from './env.js';

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

export async function applyOneCliContainerConfig(
  args: string[],
  agent: string,
): Promise<boolean> {
  const config = getOneCliGatewayConfig();
  if (!config) return false;

  const onecli = new OneCLI({
    url: config.url,
    apiKey: config.apiKey,
  });

  return onecli.applyContainerConfig(args, { agent });
}
