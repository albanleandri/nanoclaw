import { registerProviderDescriptor } from '../provider-descriptor-registry.js';

registerProviderDescriptor({
  name: 'claude',
  displayName: 'Claude',
  protocol: 'native',
  installedBy: 'core',
  runtime: { containerProviderName: 'claude' },
  auth: {
    modes: ['onecli-secret', 'oauth'],
    onecliSecretNames: ['Claude', 'Anthropic'],
  },
  models: {
    supportedEfforts: [],
    modelIdPattern: '^[A-Za-z0-9._:-]+$',
    allowCustomModelId: true,
  },
  capabilities: {
    streaming: true,
    mcp: 'native',
    toolCalling: 'native',
    continuation: 'durable',
    followUpMode: 'push-active-turn',
    structuredOutput: 'best-effort',
    media: { images: 'native', pdfs: 'native', audio: 'native' },
    reviewMode: { readOnly: true, isolatedWorkspace: false },
  },
  installation: {
    hostContributionRequired: false,
    registrationSurfaces: ['descriptor', 'container-provider'],
  },
  setup: {
    selectable: true,
    verifyCommand: 'pnpm exec tsx setup/index.ts --step auth',
    docsPath: 'README.md',
  },
});
