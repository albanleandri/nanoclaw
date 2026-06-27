import { registerProviderDescriptor } from '../provider-descriptor-registry.js';

registerProviderDescriptor({
  name: 'openai-compatible',
  displayName: 'OpenAI-compatible endpoint',
  protocol: 'openai-compatible',
  installedBy: 'core',
  runtime: { containerProviderName: 'openai-compatible' },
  auth: { modes: ['onecli-secret', 'none'] },
  models: { modelIdPattern: '^[A-Za-z0-9._:/-]+$', allowCustomModelId: true },
  capabilities: {
    streaming: true,
    mcp: 'none',
    toolCalling: 'none',
    continuation: 'stateless',
    followUpMode: 'queue-turns',
    structuredOutput: 'best-effort',
    media: { images: 'unsupported', pdfs: 'unsupported', audio: 'unsupported' },
    reviewMode: { readOnly: false, isolatedWorkspace: true },
  },
  installation: {
    hostContributionRequired: false,
    registrationSurfaces: ['descriptor', 'container-provider', 'setup-verifier'],
  },
  setup: { selectable: true, docsPath: 'docs/providers.md' },
});
