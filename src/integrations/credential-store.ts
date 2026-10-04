import { randomBytes } from 'node:crypto';

declare const credentialRefBrand: unique symbol;

export type CredentialRef = string & { readonly [credentialRefBrand]: true };
export type CredentialStatus = 'available' | 'missing' | 'unsafe';

export interface StagedCredential {
  readonly token: string;
}

export interface HostCredentialStore {
  status(ref: CredentialRef): Promise<CredentialStatus>;
  /** Host integration invocation only; never expose this result through status/list APIs. */
  read(ref: CredentialRef): Promise<unknown>;
  stage(ref: CredentialRef, value: unknown): Promise<StagedCredential>;
  promote(staged: StagedCredential): Promise<void>;
  discard(staged: StagedCredential): Promise<void>;
  /** Ordinary unlink only; this does not claim secure erasure on flash or journaling filesystems. */
  revoke(ref: CredentialRef): Promise<void>;
}

export type CredentialStoreErrorCode =
  'invalid_reference' | 'missing' | 'unsafe' | 'invalid_payload' | 'invalid_stage' | 'io';

export class CredentialStoreError extends Error {
  constructor(
    readonly code: CredentialStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

const CREDENTIAL_REF = /^cred_[0-9a-f]{32}$/;

export function createCredentialRef(): CredentialRef {
  return `cred_${randomBytes(16).toString('hex')}` as CredentialRef;
}

export function parseCredentialRef(value: string): CredentialRef {
  if (!CREDENTIAL_REF.test(value)) {
    throw new CredentialStoreError('invalid_reference', 'Credential reference is invalid');
  }
  return value as CredentialRef;
}
