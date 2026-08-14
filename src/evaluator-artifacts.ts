import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import { StateLayout } from './state-layout.js'

export interface EvaluatorArtifactRecord {
  readonly kind: 'stdout' | 'stderr'
  readonly location: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly truncated: boolean
}

interface DirectoryIdentity { readonly path: string; readonly dev: number; readonly ino: number }

/** Attempt-scoped, exclusive artifact capability. Mint only after durable attempt allocation. */
export class EvaluatorArtifactWriter {
  readonly attemptDirectory: string
  private readonly parent: DirectoryIdentity
  /** Internal owner-only capability for artifact I/O; never persist this path. */
  internalPath(kind: 'stdout' | 'stderr'): string { return join(this.attemptDirectory, `${kind}.log`) }
  private used = false

  private constructor(directory: string) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('artifact attempt directory must be a real directory')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new TypeError('artifact attempt directory must be owner-controlled')
    if ((info.mode & 0o077) !== 0) throw new TypeError('artifact attempt directory must be owner-only')
    this.attemptDirectory = directory
    this.parent = Object.freeze({ path: directory, dev: info.dev, ino: info.ino })
    Object.freeze(this.parent)
  }

  static mint(layout: StateLayout, runId: string, experimentId: string, attemptId: string): EvaluatorArtifactWriter {
    const parts = [runId, experimentId, attemptId]
    if (parts.some(part => !/^[A-Za-z0-9._-]+$/u.test(part) || part === '.' || part === '..')) throw new TypeError('artifact identity contains unsafe characters')
    const directory = layout.resolve(join('artifacts', ...parts), 'directory')
    return new EvaluatorArtifactWriter(directory)
  }

  write(stdout: SubprocessOutputRead | undefined, stderr: SubprocessOutputRead | undefined, secrets: readonly string[]): readonly EvaluatorArtifactRecord[] {
    if (this.used) throw new TypeError('artifact writer is single-use')
    this.used = true
    this.assertParent()
    const normalizedSecrets = normalizeRedactionSecrets(secrets)
    return Object.freeze(([['stdout', stdout], ['stderr', stderr]] as const).map(([kind, output]) => this.writeOne(kind, output, normalizedSecrets)))
  }

  private writeOne(kind: 'stdout' | 'stderr', output: SubprocessOutputRead | undefined, secrets: readonly string[]): EvaluatorArtifactRecord {
    this.assertParent()
    const destination = this.internalPath(kind)
    const source = output?.spillPath === undefined ? output?.text ?? '' : readSpill(output.spillPath)
    const bytes = Buffer.from(redact(source, secrets))
    const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile()) throw new TypeError('artifact destination must be a regular file')
      if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) throw new TypeError('artifact destination must be owner-controlled')
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      const final = fstatSync(fd)
      if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== bytes.length) throw new TypeError('artifact destination identity changed')
    } finally { closeSync(fd) }
    this.assertParent()
    return Object.freeze({ kind, location: `artifact:sha256:${hash(Buffer.from(destination, 'utf8'))}`, sizeBytes: bytes.length, sha256: hash(bytes), truncated: output?.lossy ?? false })
  }

  private assertParent(): void {
    const info = lstatSync(this.parent.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.parent.dev || info.ino !== this.parent.ino) throw new TypeError('artifact attempt directory identity changed')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new TypeError('artifact attempt directory is not owner-controlled')
    if ((info.mode & 0o077) !== 0) throw new TypeError('artifact attempt directory is not owner-only')
    const canonical = statSync(this.parent.path)
    if (canonical.dev !== info.dev || canonical.ino !== info.ino) throw new TypeError('artifact attempt directory traverses a symlink')
  }
}

function readSpill(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new TypeError('provider spill must be a non-symlink regular file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new TypeError('provider spill identity changed before read')
    const bytes = readFileSync(fd)
    const after = lstatSync(path)
    if (after.dev !== opened.dev || after.ino !== opened.ino) throw new TypeError('provider spill identity changed during read')
    return bytes.toString('utf8')
  } finally { closeSync(fd) }
}

export function normalizeRedactionSecrets(secrets: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(secrets.filter(secret => secret.length > 0))].sort((left, right) => right.length - left.length || left.localeCompare(right)))
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
}

function hash(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
