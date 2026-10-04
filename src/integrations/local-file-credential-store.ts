import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import {
  CredentialStoreError,
  parseCredentialRef,
  type CredentialRef,
  type CredentialStatus,
  type HostCredentialStore,
  type StagedCredential,
} from './credential-store.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

interface StagedFile {
  ref: CredentialRef;
  filename: string;
  dev: number;
  ino: number;
}

interface OpenDirectory {
  fd: number;
}

export interface LocalFileCredentialStoreOptions {
  dataDir?: string;
  maxPayloadBytes?: number;
}

/** Linux host-only credential storage. Nothing in this class is mounted into a container. */
export class LocalFileCredentialStore implements HostCredentialStore {
  private readonly privateDirectory: string;
  private readonly maxPayloadBytes: number;
  private readonly staged = new Map<string, StagedFile>();

  constructor(options: LocalFileCredentialStoreOptions = {}) {
    const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
    this.privateDirectory = path.join(dataDir, 'private-integrations');
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1) {
      throw new CredentialStoreError('invalid_payload', 'Credential payload limit is invalid');
    }
  }

  async status(ref: CredentialRef): Promise<CredentialStatus> {
    const validRef = validateRef(ref);
    let directory: OpenDirectory | undefined;
    try {
      directory = this.openStorageDirectory(false);
      if (!directory) return 'missing';
      const opened = openSafeFile(directory, activeFilename(validRef), this.maxPayloadBytes);
      if (!opened) return 'missing';
      try {
        parseStoredPayload(readOpenedFile(opened.fd, opened.size));
      } finally {
        fs.closeSync(opened.fd);
      }
      return 'available';
    } catch (error) {
      // Every inspection/read failure is intentionally collapsed to the
      // non-enumerating public safety state.
      if (!(error instanceof Error)) throw error;
      return 'unsafe';
    } finally {
      if (directory) fs.closeSync(directory.fd);
    }
  }

  async read(ref: CredentialRef): Promise<unknown> {
    const validRef = validateRef(ref);
    let directory: OpenDirectory | undefined;
    try {
      directory = this.openStorageDirectory(false);
      if (!directory) throw new CredentialStoreError('missing', 'Credential is unavailable');
      const opened = openSafeFile(directory, activeFilename(validRef), this.maxPayloadBytes);
      if (!opened) throw new CredentialStoreError('missing', 'Credential is unavailable');
      try {
        return parseStoredPayload(readOpenedFile(opened.fd, opened.size));
      } finally {
        fs.closeSync(opened.fd);
      }
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      if (directory) fs.closeSync(directory.fd);
    }
  }

  async stage(ref: CredentialRef, value: unknown): Promise<StagedCredential> {
    const validRef = validateRef(ref);
    const serialized = serializePayload(value, this.maxPayloadBytes);
    let directory: OpenDirectory | undefined;
    let filename: string | undefined;
    try {
      directory = this.openStorageDirectory(true);
      if (!directory) throw new CredentialStoreError('io', 'Credential storage could not be initialized');
      const token = randomUUID();
      filename = `${activeFilename(validRef)}.stage-${token}`;
      const filePath = childPath(directory, filename);
      const fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        FILE_MODE,
      );
      let stat: fs.Stats;
      try {
        fs.fchmodSync(fd, FILE_MODE);
        fs.writeFileSync(fd, serialized);
        fs.fsyncSync(fd);
        stat = fs.fstatSync(fd);
        assertSafeFileStat(stat, this.maxPayloadBytes);
        parseStoredPayload(serialized);
      } finally {
        fs.closeSync(fd);
      }
      this.staged.set(token, { ref: validRef, filename, dev: stat.dev, ino: stat.ino });
      return Object.freeze({ token });
    } catch (error) {
      if (directory && filename) removeExactChildBestEffort(directory, filename);
      throw safeStoreError(error);
    } finally {
      if (directory) fs.closeSync(directory.fd);
    }
  }

  async promote(staged: StagedCredential): Promise<void> {
    const entry = this.requireStage(staged);
    let directory: OpenDirectory | undefined;
    try {
      directory = this.openStorageDirectory(false);
      if (!directory) throw new CredentialStoreError('unsafe', 'Credential storage is unsafe');
      assertKnownStagedFile(directory, entry, this.maxPayloadBytes);
      const active = openSafeFile(directory, activeFilename(entry.ref), this.maxPayloadBytes);
      if (active) fs.closeSync(active.fd);
      fs.renameSync(childPath(directory, entry.filename), childPath(directory, activeFilename(entry.ref)));
      this.staged.delete(staged.token);
      fs.fsyncSync(directory.fd);
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      if (directory) fs.closeSync(directory.fd);
    }
  }

  async discard(staged: StagedCredential): Promise<void> {
    const entry = this.requireStage(staged);
    let directory: OpenDirectory | undefined;
    try {
      directory = this.openStorageDirectory(false);
      if (!directory) throw new CredentialStoreError('unsafe', 'Credential storage is unsafe');
      assertKnownStagedFile(directory, entry, this.maxPayloadBytes);
      fs.unlinkSync(childPath(directory, entry.filename));
      this.staged.delete(staged.token);
      fs.fsyncSync(directory.fd);
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      if (directory) fs.closeSync(directory.fd);
    }
  }

  async revoke(ref: CredentialRef): Promise<void> {
    const validRef = validateRef(ref);
    let directory: OpenDirectory | undefined;
    try {
      directory = this.openStorageDirectory(false);
      if (!directory) return;
      const opened = openSafeFile(directory, activeFilename(validRef), this.maxPayloadBytes);
      if (!opened) return;
      fs.closeSync(opened.fd);
      fs.unlinkSync(childPath(directory, activeFilename(validRef)));
      fs.fsyncSync(directory.fd);
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      if (directory) fs.closeSync(directory.fd);
    }
  }

  private requireStage(staged: StagedCredential): StagedFile {
    if (!staged || typeof staged.token !== 'string') {
      throw new CredentialStoreError('invalid_stage', 'Staged credential handle is invalid');
    }
    const entry = this.staged.get(staged.token);
    if (!entry) throw new CredentialStoreError('invalid_stage', 'Staged credential handle is invalid');
    return entry;
  }

  private openStorageDirectory(create: boolean): OpenDirectory | undefined {
    const privateDirectory = openOrCreateDirectory(this.privateDirectory, create);
    if (!privateDirectory) return undefined;
    try {
      const storageDirectory = openOrCreateDirectory(childPath(privateDirectory, 'v1'), create);
      if (!storageDirectory) return undefined;
      return storageDirectory;
    } finally {
      fs.closeSync(privateDirectory.fd);
    }
  }
}

function validateRef(ref: CredentialRef): CredentialRef {
  return parseCredentialRef(ref as string);
}

function activeFilename(ref: CredentialRef): string {
  return `${ref}.json`;
}

function openOrCreateDirectory(directoryPath: string, create: boolean): OpenDirectory | undefined {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new CredentialStoreError('unsafe', 'Credential storage is unsafe');
    }
    try {
      fs.mkdirSync(directoryPath, { mode: DIRECTORY_MODE });
      before = fs.lstatSync(directoryPath);
    } catch {
      throw new CredentialStoreError('unsafe', 'Credential storage is unsafe');
    }
  }
  assertSafeDirectoryStat(before);
  let fd: number;
  try {
    fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new CredentialStoreError('unsafe', 'Credential storage is unsafe');
  }
  try {
    const opened = fs.fstatSync(fd);
    assertSafeDirectoryStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new CredentialStoreError('unsafe', 'Credential storage changed while it was opened');
    }
    return { fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertSafeDirectoryStat(stat: fs.Stats): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o777) !== DIRECTORY_MODE
  ) {
    throw new CredentialStoreError('unsafe', 'Credential storage directory is unsafe');
  }
}

function childPath(directory: OpenDirectory, filename: string): string {
  // Descriptor anchoring keeps an already-validated directory authoritative if
  // an ancestor is renamed after it is opened.
  return `/proc/self/fd/${directory.fd}/${filename}`;
}

function openSafeFile(
  directory: OpenDirectory,
  filename: string,
  maxPayloadBytes: number,
): { fd: number; size: number } | undefined {
  const filePath = childPath(directory, filename);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CredentialStoreError('unsafe', 'Credential file is unsafe');
  }
  assertSafeFileStat(before, maxPayloadBytes);
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new CredentialStoreError('unsafe', 'Credential file is unsafe');
  }
  try {
    const opened = fs.fstatSync(fd);
    assertSafeFileStat(opened, maxPayloadBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new CredentialStoreError('unsafe', 'Credential file changed while it was opened');
    }
    return { fd, size: opened.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertSafeFileStat(stat: fs.Stats, maxPayloadBytes: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== FILE_MODE ||
    stat.size < 1 ||
    stat.size > maxPayloadBytes
  ) {
    throw new CredentialStoreError('unsafe', 'Credential file is unsafe');
  }
}

function assertKnownStagedFile(directory: OpenDirectory, entry: StagedFile, maxPayloadBytes: number): void {
  const opened = openSafeFile(directory, entry.filename, maxPayloadBytes);
  if (!opened) throw new CredentialStoreError('unsafe', 'Staged credential is unavailable');
  try {
    const stat = fs.fstatSync(opened.fd);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new CredentialStoreError('unsafe', 'Staged credential changed before promotion');
    }
    parseStoredPayload(readOpenedFile(opened.fd, opened.size));
  } finally {
    fs.closeSync(opened.fd);
  }
}

function readOpenedFile(fd: number, expectedSize: number): string {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (read === 0) throw new CredentialStoreError('unsafe', 'Credential file changed while it was read');
    offset += read;
  }
  const extra = Buffer.allocUnsafe(1);
  if (fs.readSync(fd, extra, 0, 1, offset) !== 0) {
    throw new CredentialStoreError('unsafe', 'Credential file changed while it was read');
  }
  return bytes.toString('utf8');
}

function serializePayload(value: unknown, maxPayloadBytes: number): string {
  if (!isPlainRecord(value)) throw new CredentialStoreError('invalid_payload', 'Credential payload must be an object');
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value)}\n`;
  } catch {
    throw new CredentialStoreError('invalid_payload', 'Credential payload is not valid JSON');
  }
  if (Buffer.byteLength(serialized) > maxPayloadBytes) {
    throw new CredentialStoreError('invalid_payload', 'Credential payload is too large');
  }
  return serialized;
}

function parseStoredPayload(serialized: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CredentialStoreError('unsafe', 'Credential file does not contain valid JSON');
  }
  if (!isPlainRecord(value)) throw new CredentialStoreError('unsafe', 'Credential file does not contain an object');
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new CredentialStoreError('unsafe', 'Credential ownership cannot be verified on this platform');
  }
  return process.getuid();
}

function safeStoreError(error: unknown): CredentialStoreError {
  if (error instanceof CredentialStoreError) return error;
  return new CredentialStoreError('io', 'Credential store operation failed');
}

function removeExactChildBestEffort(directory: OpenDirectory, filename: string): void {
  /* eslint-disable no-catch-all/no-catch-all -- cleanup must preserve the original staging failure */
  try {
    fs.unlinkSync(childPath(directory, filename));
  } catch {
    // Preserve the original failure. Stale staged files are never active.
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
