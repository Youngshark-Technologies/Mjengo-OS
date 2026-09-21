// The default storage driver: local disk, byte-identical to the historical
// /api/upload photo path (task 9-b) and the documents service's public/docs
// write (issue #37). Photo files land in public/photos/<key>, document files
// in public/docs/<key> for `docs/`-prefixed keys — served by the Next server
// at /photos/<key> and /docs/<key> — the single-box self-host contract every
// prior release shipped. canPresign is FALSE: there is no signing to do when
// the web server is also the file server, so the client-direct presigned flow
// and the re-sign endpoint honestly 409 instead of pretending.
//
// `put` is deliberately strict about the key: one flat segment of safe
// characters ([A-Za-z0-9][A-Za-z0-9._-]*), optionally behind the ONE
// allowlisted `docs/` prefix — no traversal, no other separators — exactly
// the shapes the server itself generates (upp-<ts>-<hex>.<ext> and
// doc-<ts>-<hex>.<ext>). Today's routes never wrote anything else; the
// adapter just refuses to become a general-purpose file writer.

import { mkdir, open, readFile, stat, writeFile } from 'fs/promises'
import path from 'path'
import type { ObjectRead, ObjectStat, StorageAdapter } from './types'

/** Flat, traversal-free, server-generated key shapes only. */
const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The ONE allowlisted key prefix (the documents tree, issue #37). */
const DOCS_PREFIX = 'docs/'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
}

export interface LocalDiskOptions {
  /**
   * Base directory flat (photo) keys are written under. Defaults to
   * <cwd>/public/photos — exactly where /api/upload always wrote. The option
   * exists as the test seam (tmp dir), not as a deployment knob.
   */
  photosDir?: string
  /**
   * Base directory `docs/`-prefixed keys are written under. Defaults to
   * <dirname(photosDir)>/docs — public/docs in the app, a sibling of the tmp
   * photos dir in tests. Same seam status as photosDir.
   */
  docsDir?: string
}

/** Where a key lands (null = refused shape — never a general file writer). */
function resolveTarget(key: string, photosDir: string, docsDir: string): { dir: string; name: string } | null {
  if (key.startsWith(DOCS_PREFIX)) {
    const name = key.slice(DOCS_PREFIX.length)
    return SAFE_KEY_RE.test(name) ? { dir: docsDir, name } : null
  }
  return SAFE_KEY_RE.test(key) ? { dir: photosDir, name: key } : null
}

export function createLocalDiskDriver(opts: LocalDiskOptions = {}): StorageAdapter {
  const photosDir = opts.photosDir ?? path.join(process.cwd(), 'public', 'photos')
  const docsDir = opts.docsDir ?? path.join(path.dirname(photosDir), 'docs')

  return {
    id: 'local-disk',
    canPresign: false,

    async put(key: string, bytes, _contentType) {
      const target = resolveTarget(key, photosDir, docsDir)
      if (!target) {
        throw new Error(
          `local-disk driver: unsafe storage key ${JSON.stringify(key)} — expected a single server-generated segment like upp-<ts>-<hex>.<ext> or docs/doc-<ts>-<hex>.<ext>`,
        )
      }
      await mkdir(target.dir, { recursive: true }) // runtime state, created on demand (as before)
      await writeFile(path.join(target.dir, target.name), bytes)
    },

    publicUrl(key: string): string {
      return key.startsWith(DOCS_PREFIX) ? `/docs/${key.slice(DOCS_PREFIX.length)}` : `/photos/${key}`
    },

    // Not required by any current flow (presign 409s for this driver), but
    // honest + cheap: the confirm route can verify a key against the real
    // disk instead of special-casing. Content-Type is derived from the
    // extension — local files carry no metadata side-channel.
    async statObject(key: string): Promise<ObjectStat> {
      const target = resolveTarget(key, photosDir, docsDir)
      if (!target) return { exists: false, sizeBytes: null, contentType: null }
      const s = await stat(path.join(target.dir, target.name)).catch(() => null)
      if (!s) return { exists: false, sizeBytes: null, contentType: null }
      const ext = key.split('.').pop() ?? ''
      return { exists: true, sizeBytes: s.size, contentType: EXT_MIME[ext] ?? null }
    },

    // Read seam (issue #37): byte-identical passthrough for objects THIS
    // driver wrote. null = no such object (or an unsafe key) — never a guess,
    // never a throw for plain absence. Content-Type from the extension map,
    // exactly like statObject.
    async read(key: string): Promise<ObjectRead | null> {
      const target = resolveTarget(key, photosDir, docsDir)
      if (!target) return null
      const bytes = await readFile(path.join(target.dir, target.name)).catch(() => null)
      if (!bytes) return null
      const ext = key.split('.').pop() ?? ''
      return { bytes, contentType: EXT_MIME[ext] ?? null, sizeBytes: bytes.length }
    },

    // Prefix-read seam (register SEC-8 — the magic-number sniff source):
    // open + read ONLY the first maxBytes (never the whole file into memory).
    // null = no such object / unsafe key; an EMPTY Buffer = the file exists
    // but is zero bytes — a state confirm refuses on its own terms.
    async readPrefix(key: string, maxBytes: number): Promise<Buffer | null> {
      const target = resolveTarget(key, photosDir, docsDir)
      if (!target) return null
      const handle = await open(path.join(target.dir, target.name), 'r').catch(() => null)
      if (!handle) return null
      try {
        const buf = Buffer.alloc(Math.max(0, maxBytes))
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        return buf.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },

    // keyFor (issues #37 + #38): the inverse of publicUrl for the two URL
    // shapes this driver mints (/photos/<key>, /docs/<key>) — legacy
    // document rows recorded `/docs/<name>` before the driver seam existed,
    // and that exact shape is what publicUrl still produces, so both eras
    // resolve identically. Anything else (foreign hosts, other path shapes)
    // is honestly null: this driver cannot address it.
    keyFor(storageKey: string): string | null {
      if (storageKey.startsWith('/photos/')) {
        const key = storageKey.slice('/photos/'.length)
        return SAFE_KEY_RE.test(key) ? key : null
      }
      if (storageKey.startsWith('/docs/')) {
        const name = storageKey.slice('/docs/'.length)
        return SAFE_KEY_RE.test(name) ? `${DOCS_PREFIX}${name}` : null
      }
      return null
    },
  }
}

/** The process-wide default instance (public/photos + public/docs of the running app). */
export const localDiskDriver: StorageAdapter = createLocalDiskDriver()
