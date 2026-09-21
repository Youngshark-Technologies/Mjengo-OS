// Storage driver factory (task 9-b). THE RULE IS FAIL-CLOSED AND HONEST:
// the S3/R2/MinIO driver is selected ONLY when the full required env set is
// present; anything less — unset, blank, whitespace — is the local-disk
// default, exactly the self-host behavior of every prior release. A PARTIAL
// env set warns once (key NAMES only — values are secrets and never logged)
// so an operator who fat-fingers one variable learns about it instead of
// silently uploading to the app server's disk.
//
//   S3_ENDPOINT            e.g. https://s3.eu-central-1.amazonaws.com
//                          or   https://<account>.r2.cloudflarestorage.com
//   S3_REGION              e.g. eu-central-1 (auto for R2)
//   S3_BUCKET
//   S3_ACCESS_KEY_ID       secret
//   S3_SECRET_ACCESS_KEY   secret
//   S3_PUBLIC_BASE         optional CDN/public base for stable replay URLs
//
// getStorageDriver() caches the resolved driver (the env is read once per
// process — same posture as every other env-gated seam in this app) and
// setStorageDriverForTests() is the injection seam: tests swap the driver
// (or reset to null to re-resolve) without touching process.env.

import { createS3CompatDriver } from './s3-compat'
import { localDiskDriver } from './local-disk'
import type { StorageAdapter } from './types'

export type { ObjectRead, ObjectStat, ObjectPrefix, PresignedPut, StorageAdapter, PresignCapableAdapter } from './types'
export { asPresignCapable } from './types'
export { sniffMagicBytes, MAGIC_SNIFF_PREFIX_BYTES, type SniffedMagicType } from './magic-sniff'
export { createLocalDiskDriver, localDiskDriver } from './local-disk'
export { createS3CompatDriver, DEFAULT_GET_PRESIGN_EXPIRES_SEC } from './s3-compat'
export {
  sigv4Presign,
  deriveSigningKey,
  sha256Hex,
  hmacSha256,
  awsUriEncode,
  canonicalUri,
  amzTimestamps,
  parseEndpoint,
  MAX_PRESIGN_EXPIRES_SEC,
  type SigV4Presign,
  type SigV4PresignOptions,
  type PresignMethod,
} from './sigv4'
import { log } from '../log'

/** The env contract the factory reads (subset of process.env). */
export interface StorageEnv {
  S3_ENDPOINT?: string
  S3_REGION?: string
  S3_BUCKET?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  S3_PUBLIC_BASE?: string
}

const REQUIRED_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

/**
 * process.env → StorageEnv. An explicit (possibly partial) env wins — the
 * injection path tests use; omitted → the live process env.
 */
export function readStorageEnv(env?: StorageEnv): StorageEnv {
  if (env) return env
  return {
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_PUBLIC_BASE: process.env.S3_PUBLIC_BASE,
  }
}

let warnedPartial = false

/**
 * Pure resolution (no caching, no clock): full env set → s3-compat; anything
 * else → local-disk, with a one-time warn when the env was PARTIALLY set
 * (the classic misconfiguration: bucket but no secret).
 */
export function resolveStorageDriver(env: StorageEnv): StorageAdapter {
  const missing = REQUIRED_KEYS.filter((k) => !String(env[k] ?? '').trim())
  if (missing.length === 0) {
    // The endpoint is validated here (parses, http(s)) so a malformed value
    // throws at first use with an honest message instead of producing
    // 500-shaped mysteries per request.
    return createS3CompatDriver({
      endpoint: String(env.S3_ENDPOINT).trim(),
      region: String(env.S3_REGION).trim(),
      bucket: String(env.S3_BUCKET).trim(),
      accessKeyId: String(env.S3_ACCESS_KEY_ID).trim(),
      // The secret is used verbatim — never trimmed (a secret with
      // meaningful edge bytes would be silently corrupted by trimming).
      secretAccessKey: String(env.S3_SECRET_ACCESS_KEY),
      publicBase: env.S3_PUBLIC_BASE?.trim() || undefined,
    })
  }

  const anySet = [...REQUIRED_KEYS, 'S3_PUBLIC_BASE'].some((k) => String(env[k] ?? '').trim())
  if (anySet && !warnedPartial) {
    warnedPartial = true
    log.warn(
      'storage',
      `S3 configuration incomplete (missing ${missing.join(', ')}) — ` +
        `falling back to the local-disk driver (public/photos on this server). ` +
        `Set all of ${REQUIRED_KEYS.join(', ')} to enable object storage.`,
      { missing },
    )
  }
  return localDiskDriver
}

let cachedDriver: StorageAdapter | null = null

/** The app's storage driver (cached after first resolution). */
export function getStorageDriver(): StorageAdapter {
  if (!cachedDriver) cachedDriver = resolveStorageDriver(readStorageEnv())
  return cachedDriver
}

/**
 * TEST SEAM: force the driver getStorageDriver() returns (pass null to make
 * the factory re-resolve from the live env). Never called by app code.
 */
export function setStorageDriverForTests(driver: StorageAdapter | null): void {
  cachedDriver = driver
}

/** TEST SEAM: re-arm the one-time partial-env warning (module state). */
export function resetStorageWarnForTests(): void {
  warnedPartial = false
}
