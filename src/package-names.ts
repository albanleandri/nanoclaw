export const MAX_PACKAGES_PER_REQUEST = 20;

const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_APT_PACKAGE_LENGTH = 255;
const MAX_NPM_PACKAGE_LENGTH = 214;

export interface ValidatedPackageLists {
  apt: string[];
  npm: string[];
}

export function validatePackageName(kind: 'apt' | 'npm', value: unknown): string {
  const pattern = kind === 'apt' ? APT_PACKAGE_RE : NPM_PACKAGE_RE;
  const maxLength = kind === 'apt' ? MAX_APT_PACKAGE_LENGTH : MAX_NPM_PACKAGE_LENGTH;
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value)) {
    throw new Error(`invalid ${kind} package name`);
  }
  return value;
}

export function validatePackageLists(
  aptValue: unknown,
  npmValue: unknown,
  options: { requireOne?: boolean; maxCount?: number } = {},
): ValidatedPackageLists {
  if (!Array.isArray(aptValue) || !Array.isArray(npmValue)) {
    throw new Error('package lists must be arrays');
  }
  if (options.maxCount !== undefined && aptValue.length + npmValue.length > options.maxCount) {
    throw new Error(`max ${options.maxCount} packages per request`);
  }
  if (options.requireOne && aptValue.length + npmValue.length === 0) {
    throw new Error('at least one apt or npm package is required');
  }

  return {
    apt: aptValue.map((value) => validatePackageName('apt', value)),
    npm: npmValue.map((value) => validatePackageName('npm', value)),
  };
}
