// Object-storage driver seam (upload module, task 9-b — issue "Move uploads
// to object storage (presigned URLs)").
//
// One narrow interface every upload path talks to, so the SAME route code
// serves the self-host single-box default (local disk under public/photos,
// served by the Next server) and an S3/R2/MinIO-compatible bucket (files
// PUT server-side, or client-direct via presigned URLs when the driver
// supports it). The factory lives in ./index.ts.
//
// KEY CONTRACT (mirrors the historical /api/upload photo key shape): a
// storage key is either a single flat segment like `upp-1712345678-abcd12.jpg`
// (the photo tree) or the SAME flat segment behind one allowlisted prefix,
// `docs/<segment>` (the document tree, issue #37) — server-generated, never
// user-supplied. The DRIVER owns where it lands:
//   · local-disk  → public/photos/<key> / public/docs/<docs key>
//                 (exactly today's file layouts)
//   · s3-compat   → s3://<bucket>/<key>   (path-style URLs; documents under
//                 the `docs/` prefix in the bucket)
//
// URL CONTRACT: `publicUrl(key)` is the string the app records and the
// frontend renders (<img src=…>). For local-disk it is the stable path
// /photos/<key>; for s3-compat it is the public CDN base (S3_PUBLIC_BASE)
// when one is configured, otherwise a presigned GET URL — see
// src/backend/lib/storage/s3-compat.ts for the honest expiry tradeoff.

import type { Buffer } from 'buffer'

/** Result shape of a presigned PUT (client-direct upload capability). */
export interface PresignedPut {
  /** Signed URL the client PUTs its bytes to (method-bound, time-limited). */
  url: string
  /**
   * Headers the client SHOULD send with the PUT. Content-Type is NOT part of
   * the signature (signed headers are host-only — see sigv4.ts), so this is
   * an advisory contract: S3 stores whatever Content-Type the PUT carries,
   * and /api/upload/confirm verifies it after the fact.
   */
  headers: Record<string, string>
}

/** Object metadata as reported by a HEAD-style check (confirm flow). */
export interface ObjectStat {
  exists: boolean
  sizeBytes: number | null
  contentType: string | null
}

/**
 * Result shape of the READ seam (issue #37 — "the storage driver seam handles
 * photos but documents still bypass it"): the exact bytes plus whatever
 * metadata the driver honestly knows (S3 GET headers; local-disk has only the
 * extension map). `null` from read() means "no such object" — never a guess.
 */
export interface ObjectRead {
  bytes: Buffer
  /** Content type as the store reports it (S3) or the extension map (local) — null when unknown. */
  contentType: string | null
  sizeBytes: number
}

/**
 * Result shape of the PREFIX-READ seam (register SEC-8 — the magic-number
 * sniff source): the FIRST bytes of a stored object, without pulling the
 * whole thing through the app. An EMPTY Buffer means "the object exists but
 * is zero bytes" — a state upload-confirm must refuse on its own terms, so
 * it is deliberately distinct from `null`, which still means "no such
 * object".
 */
export type ObjectPrefix = Buffer

/**
 * The storage adapter. `presignPut` / `presignGet` are OPTIONAL capabilities
 * (local disk cannot presign — its files are already served by the Next
 * server); `statObject` / `read` / `keyFor` are optional for the same reason
 * anything is: a driver that cannot verify an object's existence answers the
 * confirm route with an honest 409 instead of guessing, and a driver that
 * cannot read bytes back (or resolve a recorded URL to its key) leaves the
 * document-extraction / re-sign callers with honest errors, never guesses.
 */
export interface StorageAdapter {
  readonly id: 'local-disk' | 's3-compat'
  /** True when presignPut/presignGet are implemented (client-direct flow). */
  readonly canPresign: boolean
  /** Write bytes to the driver's storage at `key` (server-mediated put). */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  /** The URL the app records + the frontend renders for `key`. */
  publicUrl(key: string): string
  /** Capability: mint a time-limited signed PUT URL for `key`. */
  presignPut?(key: string, contentType: string, expiresSec: number): PresignedPut
  /** Capability: mint a time-limited signed GET URL for `key`. */
  presignGet?(key: string, expiresSec: number): string
  /** Capability: existence + size + content-type probe for `key`. */
  statObject?(key: string): Promise<ObjectStat>
  /** Capability (issue #37): read the stored bytes for `key` back. null = no such object. */
  read?(key: string): Promise<ObjectRead | null>
  /**
   * Capability (register SEC-8): read the FIRST `maxBytes` bytes of the
   * stored object for `key` — the magic-number sniff source. null = no such
   * object; an EMPTY Buffer = the object exists but is zero bytes. Drivers
   * SHOULD honor the prefix cheaply (S3: a ranged GET) instead of pulling
   * the whole object through the app.
   */
  readPrefix?(key: string, maxBytes: number): Promise<ObjectPrefix | null>
  /**
   * Capability (issues #37 + #38): resolve a recorded `storageKey` (a
   * publicUrl THIS driver minted, or a legacy local path shape it serves)
   * back to the driver key it addresses. null = the value does not address
   * an object this driver can serve (foreign URL shapes, unsupported legacy
   * paths) — callers turn that into honest errors, never guesses.
   */
  keyFor?(storageKey: string): string | null
}

/**
 * A driver that implements the presigned flow, narrowed so route code can
 * call presignPut/presignGet without non-null assertions. `asPresignCapable`
 * checks the capability honestly (canPresign AND both methods present) — a
 * driver that claims canPresign but lacks the methods is a bug, and this
 * guard turns it into a null the caller maps to an honest error.
 */
export interface PresignCapableAdapter extends StorageAdapter {
  presignPut(key: string, contentType: string, expiresSec: number): PresignedPut
  presignGet(key: string, expiresSec: number): string
}

export function asPresignCapable(driver: StorageAdapter): PresignCapableAdapter | null {
  if (
    driver.canPresign &&
    typeof driver.presignPut === 'function' &&
    typeof driver.presignGet === 'function'
  ) {
    return driver as PresignCapableAdapter
  }
  return null
}
