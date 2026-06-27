import { registerProviderDescriptor } from '../provider-descriptor-registry.js';

registerProviderDescriptor({
  name: 'codex',
  displayName: 'Codex',
  protocol: 'native',
  installedBy: 'core',
  runtime: { containerProviderName: 'codex', hostContributionName: 'codex' },
  auth: {
    modes: ['onecli-secret', 'host-file'],
    onecliSecretNames: ['Codex', 'OpenAI'],
    supportsHostFile: true,
  },
  models: {
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    modelIdPattern: '^[A-Za-z0-9._:-]+$',
    allowCustomModelId: true,
  },
  capabilities: {
    streaming: true,
    mcp: 'native',
    toolCalling: 'native',
    continuation: 'provider-thread',
    followUpMode: 'queue-turns',
    structuredOutput: 'best-effort',
    media: { images: 'file-reference', pdfs: 'file-reference', audio: 'file-reference' },
    reviewMode: { readOnly: true, isolatedWorkspace: true },
  },
  installation: {
    skill: 'add-codex',
    hostContributionRequired: true,
    containerPackages: { cliTools: ['@openai/codex'] },
    registrationSurfaces: ['descriptor', 'container-provider', 'host-contribution', 'setup-verifier'],
  },
  setup: {
    selectable: true,
    verifyCommand: 'pnpm exec tsx setup/index.ts --step provider-auth codex --check',
    docsPath: '.claude/skills/add-codex/SKILL.md',
  },
});
