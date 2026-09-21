// S3/R2/MinIO-compatible driver (task 9-b). Path-style URLs
// (https://<endpoint-host>/<bucket>/<key>), SigV4 query-string presigning
// via ./sigv4.ts, and fetch for ALL wire traffic — zero new dependencies.
//
// WHY EVERYTHING GOES THROUGH PRESIGNED URLS (including server-side writes):
// the alternative would be a second, header-based SigV4 implementation
// (Authorization header + x-amz-content-sha256) that no test pins. Minting a
// short-lived presigned URL and fetching it reuses the SAME signer the
// client-direct flow exercises — one signing code path, fully covered by the
// golden tests. put() mints a 60s PUT URL and sends the bytes immediately;
// statObject() mints a 60s HEAD URL. The signature never leaves the process
// in a response (only the presign route hands one to a client, deliberately).
//
// publicUrl(key) — the honest tradeoff, choose per deployment:
//   · S3_PUBLIC_BASE set (recommended: bucket or CDN fronting it):
//     `${base}/${key}` — stable, replayable forever, what Attachment rows
//     should store.
//   · UNSET: a presigned GET (default 7 days — the SigV4 maximum). Works
//     immediately, but URLs recorded today stop resolving next week. This is
//     the documented limitation of a private bucket without a public base;
//     the fix is operational (set the base), not code (a replay-time
//     re-signing seam is the follow-up this consciously defers).
//
// Content-Type on put()/presignPut(): the signature covers host only, so the
// header is advisory — S3 stores whatever the PUT carries and reports it on
// HEAD, which /api/upload/confirm uses to verify the client kept the
// contract. Errors thrown here are single-line and secret-free (no URLs —
// they carry signatures; no credentials) so route error mappers pass them
// through honestly.
//
// read() / keyFor() (issues #37 + #38): read mints a 60s presigned GET and
// fetches it — same one-signing-code-path posture as put/statObject. keyFor
// reverses publicUrl(): it recognizes the two URL prefixes this driver can
// mint (the S3_PUBLIC_BASE, or the endpoint origin for the no-base presigned
// form), strips the /<bucket>/ object-path prefix, and decodes the key
// segments. Rows whose storageKey neither prefix explains (another
// deployment's shapes) resolve to null — callers answer honestly, they never
// guess a key.

import type { ObjectRead, ObjectStat, PresignedPut, StorageAdapter } from './types'
import { canonicalUri, parseEndpoint, sigv4Presign } from './sigv4'

/** Server-mediated put() mints + consumes the URL immediately. */
const SERVER_OP_EXPIRES_SEC = 60
/** publicUrl() default when no S3_PUBLIC_BASE: the SigV4 7-day maximum. */
export const DEFAULT_GET_PRESIGN_EXPIRES_SEC = 604_800

export interface S3CompatConfig {
  /** Full endpoint origin, e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Public base for stable URLs (CDN or public bucket). No trailing slash. */
  publicBase?: string
  /** Injectable clock for deterministic URLs in tests. */
  now?: () => Date
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch
}

export function createS3CompatDriver(config: S3CompatConfig): StorageAdapter {
  // Fail closed at construction: an unusable endpoint must never degrade to
  // a silently-wrong driver (and a missing bucket/credentials is a factory
  // concern — see index.ts).
  const { origin, host } = parseEndpoint(config.endpoint)
  if (!config.bucket.trim()) throw new Error('s3-compat driver: S3_BUCKET is empty')
  if (!config.accessKeyId.trim()) throw new Error('s3-compat driver: S3_ACCESS_KEY_ID is empty')
  if (!config.secretAccessKey) throw new Error('s3-compat driver: S3_SECRET_ACCESS_KEY is empty')

  const doFetch = config.fetchImpl ?? fetch
  const presign = (method: 'GET' | 'PUT' | 'HEAD', key: string, expiresSec: number) =>
    sigv4Presign({
      method,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      key,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSec,
      now: config.now,
    })

  /** Object URL path, single-encoded (same shape the signer canonicalizes). */
  const objectPath = (key: string) => canonicalUri(config.bucket, key)

  /**
   * keyFor helper: strip `/<bucket>/` off an object path and decode the key
   * segments (publicUrl single-encodes them). Traversal shapes refuse
   * honestly with null: WHATWG URL parsing already collapses dot segments
   * (including their %2E-encoded forms), and the explicit empty/dot segment
   * check here is the second layer — the resolved key is fed back into the
   * signer, so it must be a plain object path.
   */
  const keyFromObjectPath = (objectPathname: string): string | null => {
    const bucketPrefix = `/${config.bucket}/`
    if (!objectPathname.startsWith(bucketPrefix)) return null
    const keyPath = objectPathname.slice(bucketPrefix.length)
    if (!keyPath) return null
    let segments: string[]
    try {
      segments = keyPath.split('/').map((seg) => decodeURIComponent(seg))
    } catch {
      return null // malformed percent-encoding — not a URL this driver minted
    }
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null
    return segments.join('/')
  }

  return {
    id: 's3-compat',
    canPresign: true,

    async put(key: string, bytes, contentType) {
      const { url } = presign('PUT', key, SERVER_OP_EXPIRES_SEC)
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(bytes),
      })
      if (!res.ok) {
        // Single-line, secret-free: no URL (it carries the signature).
        throw new Error(
          `s3-compat put failed for key "${key}" (HTTP ${res.status} from ${host})`,
        )
      }
    },

    publicUrl(key: string): string {
      const base = config.publicBase?.trim().replace(/\/+$/, '')
      if (base) return `${base}${objectPath(key)}`
      return presign('GET', key, DEFAULT_GET_PRESIGN_EXPIRES_SEC).url
    },

    presignPut(key: string, contentType: string, expiresSec: number): PresignedPut {
      const { url } = presign('PUT', key, expiresSec)
      return { url, headers: { 'Content-Type': contentType } }
    },

    presignGet(key: string, expiresSec: number): string {
      return presign('GET', key, expiresSec).url
    },

    async statObject(key: string): Promise<ObjectStat> {
      const { url } = presign('HEAD', key, SERVER_OP_EXPIRES_SEC)
      const res = await doFetch(url, { method: 'HEAD' })
      if (res.status === 404) return { exists: false, sizeBytes: null, contentType: null }
      if (!res.ok) {
        throw new Error(
          `s3-compat stat failed for key "${key}" (HTTP ${res.status} from ${host})`,
        )
      }
      const len = Number(res.headers.get('content-length') ?? '')
      return {
        exists: true,
        sizeBytes: Number.isFinite(len) ? len : null,
        contentType: res.headers.get('content-type'),
      }
    },

    // Read seam (issue #37): GET via the same presign machinery put/stat use.
    // 404 → null (a plain answer, like statObject); other failures throw the
    // same single-line, secret-free shape. sizeBytes is the ACTUAL byte count
    // read (the S3 GET body), not a header claim.
    async read(key: string): Promise<ObjectRead | null> {
      const { url } = presign('GET', key, SERVER_OP_EXPIRES_SEC)
      const res = await doFetch(url, { method: 'GET' })
      if (res.status === 404) return null
      if (!res.ok) {
        throw new Error(
          `s3-compat read failed for key "${key}" (HTTP ${res.status} from ${host})`,
        )
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      return { bytes, contentType: res.headers.get('content-type'), sizeBytes: bytes.length }
    },

    // Prefix-read seam (register SEC-8 — the magic-number sniff source): a
    // RANGED GET asks the store for exactly the first bytes (the SigV4
    // presign covers host only, so the Range header rides along unsigned —
    // the same advisory-header posture as the client's PUT Content-Type).
    // 404 → null (no such object); 416 → the object exists but is EMPTY
    // (a zero-byte object satisfies no range) → the empty Buffer, which
    // confirm refuses on its own terms instead of conflating with missing;
    // 200 (a store that ignored the Range) is capped to maxBytes locally.
    async readPrefix(key: string, maxBytes: number): Promise<Buffer | null> {
      const { url } = presign('GET', key, SERVER_OP_EXPIRES_SEC)
      const res = await doFetch(url, {
        method: 'GET',
        headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` },
      })
      if (res.status === 404) return null
      if (res.status === 416) return Buffer.alloc(0)
      if (!res.ok) {
        throw new Error(
          `s3-compat read-prefix failed for key "${key}" (HTTP ${res.status} from ${host})`,
        )
      }
      return Buffer.from(await res.arrayBuffer()).subarray(0, Math.max(0, maxBytes))
    },

    // keyFor (issues #37 + #38): reverse publicUrl() for the URL shapes this
    // driver mints. Candidates: the configured public base (its path prefix,
    // when it has one) and the endpoint origin (the no-base presigned GET
    // form — the query string is simply not part of the pathname). Relative
    // local-path shapes and foreign origins are null: this driver cannot
    // address an object another backend stored.
    keyFor(storageKey: string): string | null {
      if (!/^https?:\/\//i.test(storageKey)) return null
      let u: URL
      try {
        u = new URL(storageKey)
      } catch {
        return null
      }

      const candidates: Array<{ origin: string; pathPrefix: string }> = []
      const base = config.publicBase?.trim().replace(/\/+$/, '')
      if (base) {
        try {
          const b = new URL(base)
          candidates.push({ origin: b.origin, pathPrefix: b.pathname.replace(/\/+$/, '') })
        } catch {
          // an unparseable base is a factory-level misconfiguration; skip it
          // and let the endpoint candidate decide
        }
      }
      candidates.push({ origin, pathPrefix: '' })

      for (const candidate of candidates) {
        if (u.origin !== candidate.origin) continue
        let pathname = u.pathname
        if (candidate.pathPrefix) {
          if (!pathname.startsWith(candidate.pathPrefix)) continue
          pathname = pathname.slice(candidate.pathPrefix.length)
        }
        const key = keyFromObjectPath(pathname)
        if (key !== null) return key
      }
      return null
    },
  }
}

