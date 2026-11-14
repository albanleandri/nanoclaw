import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_CA_PATHS = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];

export function combinedCaBundle(certificate: string): string | undefined {
  for (const file of SYSTEM_CA_PATHS) {
    try {
      const system = fs.readFileSync(file, 'utf8');
      return `${system.trimEnd()}\n${certificate.trimEnd()}\n`;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error)) throw error;
    }
  }
}

/**
 * Publish content-addressed OneCLI material below the durable data directory.
 * Existing read-only bind mounts keep their inode while changed content gets
 * a new path; retries safely reuse or repair the same destination.
 */
export function stageOneCliFile(dataDir: string, kind: 'ca' | 'combined' | 'stub', content: string): string {
  const directory = path.join(dataDir, 'onecli');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('OneCLI file directory must be owned by the current user with mode 0700');
  }

  const digest = createHash('sha256').update(content).digest('hex');
  const destination = path.join(directory, `${kind}-${digest}${kind === 'stub' ? '' : '.pem'}`);
  const mode = kind === 'stub' ? 0o600 : 0o644;
  const validate = (): boolean => {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.uid !== directoryStat.uid) {
      throw new Error(`OneCLI staged file has an unexpected type or owner: ${destination}`);
    }
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return (stat.mode & 0o777) === mode && fs.readFileSync(fd, 'utf8') === content;
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    if (validate()) return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    const published = (() => {
      try {
        fs.writeFileSync(fd, content);
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.renameSync(temporary, destination);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error;
          try {
            if (validate()) return destination;
            fs.unlinkSync(destination);
          } catch (validationError) {
            if ((validationError as NodeJS.ErrnoException).code !== 'ENOENT') throw validationError;
          }
          if (attempt === 2) throw new Error(`Could not publish OneCLI staged file: ${destination}`, { cause: error });
        }
      }
      if (!validate()) throw new Error(`OneCLI staged file validation failed after publish: ${destination}`);
      return destination;
    })();
    fs.rmSync(temporary, { force: true });
    return published;
  } catch (error) {
    // Preserve the publish/write error if cleanup also fails. A cleanup error
    // after an otherwise successful publish is still surfaced by the first
    // rmSync above.
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort only while another error is already in flight.
    }
    throw error;
  }
}
