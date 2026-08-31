import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class StateLayoutError extends Error {
  constructor(message: string) { super(message); this.name = 'StateLayoutError' }
}

/** Owner-only, non-symlink filesystem capability rooted at one canonical state directory. */
export class StateLayout {
  readonly root: string
  private constructor(root: string) { this.root = root }

  static open(root: string): StateLayout {
    const absolute = resolve(root)
    mkdirSync(absolute, { recursive: true, mode: 0o700 })
    const info = lstatSync(absolute)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StateLayoutError('state root must be a real directory')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new StateLayoutError('state root must be owned by the current user')
    if ((info.mode & 0o077) !== 0) throw new StateLayoutError('state root must not be accessible by group or other users')
    chmodSync(absolute, 0o700)
    return new StateLayout(realpathSync(absolute))
  }
  /** Verify an existing owner-only state directory without changing permissions or creating nodes. */
  static inspect(root: string): StateLayout {
    const absolute = resolve(root)
    const info = lstatSync(absolute)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StateLayoutError('state root must be a real directory')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new StateLayoutError('state root must be owned by the current user')
    if ((info.mode & 0o077) !== 0) throw new StateLayoutError('state root must not be accessible by group or other users')
    return new StateLayout(realpathSync(absolute))
  }


  resolve(relativePath: string, kind: 'file' | 'directory' = 'file'): string {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((part) => part === '..')) throw new StateLayoutError('state path must be relative and contained')
    const destination = resolve(this.root, relativePath)
    const rel = relative(this.root, destination)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new StateLayoutError('state path escapes state root')
    this.ensureParents(dirname(destination))
    if (kind === 'directory') {
      mkdirSync(destination, { mode: 0o700 })
      this.verifyNode(destination, true)
    } else if (exists(destination)) {
      this.verifyNode(destination, false)
    }
    return destination
  }

  assertContained(path: string): string {
    const absolute = resolve(path)
    const rel = relative(this.root, absolute)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new StateLayoutError('destination must be a file beneath state root')
    this.ensureParents(dirname(absolute))
    if (exists(absolute)) this.verifyNode(absolute, false)
    return absolute
  }
  /** Verify an existing contained file without changing the filesystem. */
  inspectContained(path: string): string {
    const absolute = resolve(path)
    const rel = relative(this.root, absolute)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new StateLayoutError('destination must be a file beneath state root')
    this.verifyNode(absolute, false)
    return absolute
  }


  secureFile(path: string): void {
    this.assertContained(path)
    if (!exists(path)) return
    this.verifyNode(path, false)
    chmodSync(path, 0o600)
  }

  private ensureParents(directory: string): void {
    const rel = relative(this.root, directory)
    let current = this.root
    for (const part of rel === '' ? [] : rel.split(sep)) {
      current = resolve(current, part)
      if (!exists(current)) mkdirSync(current, { mode: 0o700 })
      this.verifyNode(current, true)
      chmodSync(current, 0o700)
    }
  }

  private verifyNode(path: string, directory: boolean): void {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new StateLayoutError(`unsafe state ${directory ? 'directory' : 'file'}: ${path}`)
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new StateLayoutError(`state path is not owner-controlled: ${path}`)
    if ((info.mode & 0o077) !== 0) throw new StateLayoutError(`state path is accessible by group or other users: ${path}`)
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
