export type ProviderProtocol = 'native' | 'openai-compatible' | 'claude-compatible' | 'local-http';

export type ProviderAuthMode = 'onecli-secret' | 'host-file' | 'env' | 'oauth' | 'none';

export interface ProviderCapabilities {
  streaming: boolean;
  mcp: 'native' | 'stdio-adapter' | 'none';
  toolCalling: 'native' | 'prompt-mediated' | 'none';
  continuation: 'durable' | 'stateless' | 'provider-thread' | 'none';
  followUpMode: 'push-active-turn' | 'queue-turns' | 'unsupported';
  structuredOutput: 'strict' | 'best-effort' | 'none';
  media: {
    images: 'native' | 'file-reference' | 'unsupported';
    pdfs: 'native' | 'file-reference' | 'unsupported';
    audio: 'native' | 'file-reference' | 'unsupported';
  };
  reviewMode: {
    readOnly: boolean;
    isolatedWorkspace: boolean;
  };
}

export interface ProviderInstallation {
  skill?: string;
  hostContributionRequired: boolean;
  containerPackages?: {
    apt?: string[];
    npm?: string[];
    cliTools?: string[];
  };
  registrationSurfaces: Array<'descriptor' | 'container-provider' | 'host-contribution' | 'setup-verifier'>;
}

export interface ProviderDescriptor {
  name: string;
  displayName: string;
  protocol: ProviderProtocol;
  installedBy: 'core' | 'skill' | 'local';
  runtime: {
    containerProviderName: string;
    hostContributionName?: string;
  };
  auth: {
    modes: ProviderAuthMode[];
    onecliSecretNames?: string[];
    envAllowlist?: string[];
    supportsHostFile?: boolean;
  };
  models: {
    defaultModel?: string;
    supportedEfforts?: string[];
    modelIdPattern?: string;
    allowCustomModelId: boolean;
  };
  capabilities: ProviderCapabilities;
  installation: ProviderInstallation;
  setup?: {
    selectable?: boolean;
    verifyCommand?: string;
    docsPath?: string;
  };
}

export const PROVIDER_PROTOCOLS = new Set<ProviderProtocol>([
  'native',
  'openai-compatible',
  'claude-compatible',
  'local-http',
]);

export const PROVIDER_AUTH_MODES = new Set<ProviderAuthMode>(['onecli-secret', 'host-file', 'env', 'oauth', 'none']);

export function validateProviderDescriptor(descriptor: ProviderDescriptor): void {
  if (!descriptor.name || descriptor.name !== descriptor.name.trim().toLowerCase()) {
    throw new Error(`Provider descriptor name must be normalized lowercase: ${descriptor.name || '(empty)'}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(descriptor.name)) {
    throw new Error(`Invalid provider descriptor name: ${descriptor.name}`);
  }
  if (!descriptor.displayName.trim()) throw new Error(`Provider ${descriptor.name} has no display name`);
  if (!PROVIDER_PROTOCOLS.has(descriptor.protocol)) {
    throw new Error(`Provider ${descriptor.name} has invalid protocol: ${descriptor.protocol}`);
  }
  if (!descriptor.runtime.containerProviderName.trim()) {
    throw new Error(`Provider ${descriptor.name} has no container provider name`);
  }
  if (descriptor.auth.modes.length === 0) {
    throw new Error(`Provider ${descriptor.name} must declare at least one auth mode`);
  }
  for (const mode of descriptor.auth.modes) {
    if (!PROVIDER_AUTH_MODES.has(mode)) {
      throw new Error(`Provider ${descriptor.name} has invalid auth mode: ${mode}`);
    }
  }
  if (descriptor.models.modelIdPattern) {
    try {
      new RegExp(descriptor.models.modelIdPattern);
    } catch (error) {
      throw new Error(`Provider ${descriptor.name} has invalid modelIdPattern`, { cause: error });
    }
  }
  if (!descriptor.installation.registrationSurfaces.includes('descriptor')) {
    throw new Error(`Provider ${descriptor.name} installation must register its descriptor`);
  }
}
