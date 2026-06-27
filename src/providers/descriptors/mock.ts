import { registerProviderDescriptor } from '../provider-descriptor-registry.js';

registerProviderDescriptor({
  name: 'mock',
  displayName: 'Mock (tests)',
  protocol: 'native',
  installedBy: 'core',
  runtime: { containerProviderName: 'mock' },
  auth: { modes: ['none'] },
  models: { allowCustomModelId: false },
  capabilities: {
    streaming: false,
    mcp: 'none',
    toolCalling: 'none',
    continuation: 'durable',
    followUpMode: 'queue-turns',
    structuredOutput: 'best-effort',
    media: { images: 'unsupported', pdfs: 'unsupported', audio: 'unsupported' },
    reviewMode: { readOnly: true, isolatedWorkspace: true },
  },
  installation: {
    hostContributionRequired: false,
    registrationSurfaces: ['descriptor', 'container-provider'],
  },
  setup: { selectable: false },
});
