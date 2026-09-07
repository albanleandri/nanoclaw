import { registerProviderDescriptor } from '../provider-descriptor-registry.js';

registerProviderDescriptor({
  name: 'opencode',
  displayName: 'OpenCode',
  protocol: 'native',
  installedBy: 'skill',
  runtime: { containerProviderName: 'opencode', hostContributionName: 'opencode' },
  auth: {
    modes: ['onecli-secret'],
    onecliSecretNames: ['Proton Lumo'],
  },
  models: {
    modelIdPattern: '^[A-Za-z0-9._:/-]+$',
    allowCustomModelId: true,
  },
  capabilities: {
    streaming: true,
    mcp: 'native',
    toolCalling: 'native',
    continuation: 'durable',
    followUpMode: 'push-active-turn',
    structuredOutput: 'best-effort',
    media: { images: 'native', pdfs: 'native', audio: 'unsupported' },
    reviewMode: { readOnly: false, isolatedWorkspace: false },
  },
  installation: {
    skill: 'add-opencode',
    hostContributionRequired: true,
    containerPackages: { cliTools: ['opencode-ai'] },
    registrationSurfaces: ['descriptor', 'container-provider', 'host-contribution'],
  },
  setup: {
    selectable: true,
    docsPath: '.claude/skills/add-opencode/SKILL.md',
  },
});
