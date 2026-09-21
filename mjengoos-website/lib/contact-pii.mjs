// Contact-PII encryption at rest (MD-3, issue #362).
//
// The website's contact/demo forms persist every submission to
// data/submissions.json — historically as PLAINTEXT PII (name, email,
// phone, message…). The retention/DPA guidance of issue #151 landed, but
// the file on the `website-data` volume (and every tar backup of it) was
// still readable by anyone who could read the volume or the backup dir.
// For a marketing site whose only state is that one file, plaintext lead
// PII is an exposure disproportionate to the product — so the PII fields
// are now SEALED with AES-256-GCM under a CONTACT_PII_KEY secret before
// they ever touch disk:
//
//   · `id`, `ts`, `source` stay PLAINTEXT on purpose — the store remains
//     inspectable without the key for exactly the things operations needs
//     (entry counts, the 500-entry retention cap's eviction order, and
//     targeting a row for erasure by id/timestamp). No PII hides there.
//   · Every other field (CONTACT_PII_FIELDS) is sealed per-field with a
//     fresh 12-byte IV and the GCM tag bound by AAD to
//     `contact-pii:v1:<submission id>:<field>` — so a sealed value cannot
//     be silently moved to another field or another row (cut-and-paste
//     inside the file fails authentication).
//   · Key posture (the VAPID_SUBJECT / issue #354 shape):
//       CONTACT_PII_KEY set + decodes to exactly 32 bytes (64 hex chars
//         or base64 — `openssl rand -base64 32`) → used verbatim;
//       unset/blank + NODE_ENV=production → FAIL CLOSED: the contact
//         route refuses submissions with 503 and NOTHING is written —
//         never plaintext "as a fallback";
//       unset/blank + any other runtime → the LABELED dev-fallback key
//         (derived, documented, not secret — dev/test stays usable with
//         zero config, exactly like the NEXTAUTH_SECRET dev fallback);
//       SET BUT MALFORMED → fail closed in EVERY runtime. This one does
//         not fall back even in dev: silently sealing under a key the
//         operator cannot reproduce would lose every lead written while
//         the typo was live. A misconfiguration is surfaced, not papered
//         over.
//
// SHARED by three consumers (kept in ONE module so the format cannot
// drift): the contact route (seal on write + the legacy-plaintext
// migration sweep), the operator CLI scripts/decrypt-leads.mjs (retrieve
// leads / re-seal after an erasure edit), and the root test suite. It is
// plain .mjs — no TypeScript step, no dependencies beyond node:crypto —
// so the production image's `node` can run the CLI against the exact
// same code the route used to write the file.
//
// Retrieval + the erasure write-back path: DEPLOYMENT.md §6.3.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** Env var that carries the 32-byte key (hex or base64 encoding). */
export const CONTACT_PII_KEY_ENV = 'CONTACT_PII_KEY'

/** Marker prefix of a sealed PII value (`enc:v1:<iv>:<tag>:<ciphertext>`, base64 segments). */
export const SEALED_PREFIX = 'enc:v1:'

/**
 * The submission fields treated as PII and therefore sealed. `id`, `ts`
 * and `source` deliberately stay plaintext (see the header) — this list
 * is the complement of the route's stored shape.
 */
export const CONTACT_PII_FIELDS = [
  'name',
  'email',
  'phone',
  'organization',
  'role',
  'country',
  'projectType',
  'message',
]

/**
 * The labeled dev-fallback key — the CONTACT_PII_KEY twin of
 * DEFAULT_VAPID_SUBJECT ('mailto:admin@localhost') and the next-auth
 * fallback secret: fixed, documented, deliberately NOT secret, so
 * dev/test needs zero configuration. Derived (not random) so a dev
 * machine's sealed file decrypts identically on every restart.
 */
export const DEV_FALLBACK_CONTACT_PII_KEY = createHash('sha256')
  .update('mjengoos-contact-pii-dev-fallback')
  .digest()

/** Strict shapes accepted for CONTACT_PII_KEY. Hex is checked FIRST (hex chars are all valid base64). */
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/
const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decode a CONTACT_PII_KEY value into exactly 32 key bytes, or null when
 * the value cannot be a valid AES-256 key. Accepts the two encodings an
 * operator gets from the documented generators:
 *   · `openssl rand -hex 32`     → 64 hex chars
 *   · `openssl rand -base64 32`  → 44 padded (or 43 unpadded) base64 chars
 * @param {string | null | undefined} value
 * @returns {Buffer | null}
 */
export function decodeContactPiiKey(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  if (HEX_32_BYTES.test(trimmed)) return Buffer.from(trimmed, 'hex')
  if (BASE64_STRICT.test(trimmed)) {
    const bytes = Buffer.from(trimmed, 'base64')
    if (bytes.length === 32) return bytes
  }
  return null
}

/**
 * @typedef {'unset' | 'invalid'} ContactPiiKeyProblem
 */

/**
 * The key posture as ONE pure verdict — the same shape as
 * vapidSubjectVerdict (src/backend/modules/notify/channels.ts, issue
 * #354) and nextAuthSecretVerdict, so the decision is unit-testable
 * without touching the filesystem:
 *
 * @typedef {{ ok: true, key: Buffer, fellBack: false }} ContactPiiKeyVerdictOk
 * @typedef {{ ok: true, key: Buffer, fellBack: true, problem: 'unset' }} ContactPiiKeyVerdictFallback
 * @typedef {{ ok: false, problem: ContactPiiKeyProblem }} ContactPiiKeyVerdictRefused
 * @typedef {ContactPiiKeyVerdictOk | ContactPiiKeyVerdictFallback | ContactPiiKeyVerdictRefused} ContactPiiKeyVerdict
 */

/**
 * @param {string | null | undefined} keyEnv the raw CONTACT_PII_KEY value
 * @param {string | undefined} nodeEnv the runtime's NODE_ENV
 * @returns {ContactPiiKeyVerdict}
 */
export function contactPiiKeyVerdict(keyEnv, nodeEnv) {
  const trimmed = (keyEnv ?? '').trim()
  if (trimmed) {
    const key = decodeContactPiiKey(trimmed)
    // A SET-but-malformed key refuses in EVERY runtime — see the header.
    return key ? { ok: true, key, fellBack: false } : { ok: false, problem: 'invalid' }
  }
  if (nodeEnv === 'production') return { ok: false, problem: 'unset' }
  return { ok: true, key: DEV_FALLBACK_CONTACT_PII_KEY, fellBack: true, problem: 'unset' }
}

/** True when `value` carries the sealed-value marker (shape-checked by decrypt). */
export function isSealedContactPii(value) {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX)
}

/** The GCM additional-data binding: a sealed value is glued to its row id AND its field name. */
function aadFor(submissionId, field) {
  return Buffer.from(`contact-pii:v1:${submissionId}:${field}`, 'utf8')
}

/**
 * Seal one PII field value: AES-256-GCM, fresh 12-byte IV, 16-byte tag,
 * AAD bound to the submission id + field name (cut-and-paste of the
 * sealed value into another field or row fails authentication).
 * @param {Buffer} key exactly 32 bytes
 * @param {string} submissionId
 * @param {string} field
 * @param {string} plaintext
 * @returns {string} `enc:v1:<iv>:<tag>:<ciphertext>` (base64 segments)
 */
export function encryptContactPiiField(key, submissionId, field, plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadFor(submissionId, field))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${SEALED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * Open one sealed PII field value. Throws on ANY integrity failure —
 * wrong key, tampered ciphertext, or a value moved between fields/rows.
 * The message never includes the ciphertext or the key.
 * @param {Buffer} key exactly 32 bytes
 * @param {string} submissionId
 * @param {string} field
 * @param {string} sealed
 * @returns {string} the plaintext
 */
export function decryptContactPiiField(key, submissionId, field, sealed) {
  const parts = sealed.split(':')
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}:` !== SEALED_PREFIX) {
    throw new Error(`field "${field}" carries a malformed sealed value`)
  }
  let iv, tag, ciphertext
  try {
    iv = Buffer.from(parts[2], 'base64')
    tag = Buffer.from(parts[3], 'base64')
    ciphertext = Buffer.from(parts[4], 'base64')
  } catch {
    throw new Error(`field "${field}" carries a malformed sealed value`)
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aadFor(submissionId, field))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(
      `cannot decrypt field "${field}" of submission ${submissionId || '<no id>'} ` +
        `(wrong CONTACT_PII_KEY, tampered data, or a value moved from another field/row)`,
    )
  }
}

/**
 * Seal every PII field of one stored entry (copy-on-write — the input is
 * never mutated). Absent optional fields stay absent; `id`/`ts`/`source`
 * pass through untouched.
 *
 * A value that already LOOKS sealed is decrypt-verified with `key`:
 *   · it verifies  → passed through byte-identical (idempotent re-runs
 *     never churn the file — and rows sealed under an older key are left
 *     alone for the decrypt CLI to report honestly);
 *   · it does NOT verify → it is not one of ours (a user who literally
 *     typed "enc:v1:…" into the message box, or a stale value from a
 *     previous key) and is sealed AS PLAINTEXT, wrapping it under the
 *     current key. Nothing that fails verification ever rests in the
 *     file unsealed — a crafted prefix must not smuggle plaintext past
 *     the sealing step.
 * @param {Buffer} key
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
export function sealContactSubmission(key, entry) {
  const sealed = { ...entry }
  const id = String(entry.id ?? '')
  for (const field of CONTACT_PII_FIELDS) {
    const value = sealed[field]
    if (typeof value !== 'string' || value.length === 0) continue
    if (isSealedContactPii(value)) {
      try {
        decryptContactPiiField(key, id, field, value)
        continue // genuinely ours and current-key — leave untouched
      } catch {
        // falls through: re-seal the literal string under this key
      }
    }
    sealed[field] = encryptContactPiiField(key, id, field, value)
  }
  return sealed
}

/**
 * Open every sealed PII field of one stored entry (copy-on-write).
 * Fields that are absent or already plaintext pass through unchanged;
 * a field that FAILS to decrypt keeps its sealed value in the output
 * entry and is reported in `failures` — honest partial output, never a
 * silent drop and never a made-up value.
 * @param {Buffer} key
 * @param {Record<string, unknown>} entry
 * @returns {{ entry: Record<string, unknown>, failures: Array<{ field: string, message: string }> }}
 */
export function openContactSubmission(key, entry) {
  const opened = { ...entry }
  const failures = []
  const id = String(entry.id ?? '')
  for (const field of CONTACT_PII_FIELDS) {
    const value = opened[field]
    if (!isSealedContactPii(value)) continue
    try {
      opened[field] = decryptContactPiiField(key, id, field, value)
    } catch (err) {
      failures.push({ field, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { entry: opened, failures }
}

/**
 * True when the entry has at least one PII field resting in the file as
 * plaintext (a legacy pre-#362 row, or a hand-edited write-back). The
 * cheap prefix-only check that gates the route's migration sweep — fully
 * sealed rows are never revisited, so steady-state writes do zero
 * crypto on the existing entries.
 * @param {Record<string, unknown>} entry
 * @returns {boolean}
 */
export function hasLegacyPlaintextContactPii(entry) {
  return CONTACT_PII_FIELDS.some(
    (field) => typeof entry[field] === 'string' && entry[field].length > 0 && !isSealedContactPii(entry[field]),
  )
}

/**
 * @typedef {{ key: Buffer, refused: false }} ContactPiiChannelOk
 * @typedef {{ key: null, refused: true, problem: ContactPiiKeyProblem }} ContactPiiChannelRefused
 * @typedef {ContactPiiChannelOk | ContactPiiChannelRefused} ContactPiiChannel
 */

/**
 * Runtime×problem keys already warned in THIS process — the once-only Set
 * pattern of lib/webhook-secret-warning.ts / #354's vapidSubjectWarned.
 * A real process never changes NODE_ENV mid-run; tests that re-import
 * this module (vi.resetModules) get a fresh Set per instance.
 */
const postureWarned = new Set()

/**
 * ONE loud line per process for a refusal-grade or fallback key posture,
 * with the #354 severity split: console.error when submissions are being
 * REFUSED (production unset, or a malformed key in any runtime — the
 * operator is losing leads right now), console.warn for the labeled dev
 * fallback (usable, but say it once).
 * @param {NodeJS.ProcessEnv} env
 * @param {ContactPiiKeyProblem} problem
 */
function warnContactPiiPostureOnce(env, problem) {
  const nodeEnv = env.NODE_ENV ?? '<unset>'
  const onceKey = `${nodeEnv}|${problem}`
  if (postureWarned.has(onceKey)) return
  postureWarned.add(onceKey)

  if (problem === 'invalid') {
    // Refuses in EVERY runtime — a malformed key must never seal PII
    // that cannot be decrypted back with a key the operator holds.
    console.error(
      `[contact] CONTACT_PII_KEY is set but malformed (expected 64 hex chars or base64 of exactly ` +
        `32 bytes — e.g. \`openssl rand -base64 32\`) — the contact form FAILS CLOSED (503, nothing ` +
        `written) until the value is fixed. A bad key must never encrypt leads it cannot decrypt (MD-3, issue #362).`,
    )
    return
  }
  if (env.NODE_ENV === 'production') {
    console.error(
      `[contact] PRODUCTION POSTURE: CONTACT_PII_KEY is unset — the contact form FAILS CLOSED ` +
        `(submissions are refused with 503; no PII is written) until a key is set. Generate one ` +
        `(\`openssl rand -base64 32\`), set it in the deployment environment, and restart ` +
        `(MD-3, issue #362).`,
    )
    return
  }
  console.warn(
    `[contact] CONTACT_PII_KEY is unset — submissions in this ${nodeEnv} runtime are sealed with the ` +
      `labeled dev-fallback key (NOT secret; dev files are not protected). Generate one ` +
      `(\`openssl rand -base64 32\`) before any real deployment; production fails closed without it (MD-3, issue #362).`,
  )
}

/**
 * Resolve the sealing channel from env, at CALL time (the resolvePushChannel
 * discipline — never cached across a long-lived process or tests). The
 * refused channel carries the problem name so callers can put a precise
 * `reason` on their 503s; the posture warning (if any) has already been
 * emitted exactly once for this process.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ContactPiiChannel}
 */
export function resolveContactPiiChannel(env = process.env) {
  const verdict = contactPiiKeyVerdict(env[CONTACT_PII_KEY_ENV], env.NODE_ENV)
  if (verdict.ok && !verdict.fellBack) return { key: verdict.key, refused: false }
  if (verdict.ok) {
    warnContactPiiPostureOnce(env, 'unset')
    return { key: verdict.key, refused: false }
  }
  warnContactPiiPostureOnce(env, verdict.problem)
  return { key: null, refused: true, problem: verdict.problem }
}
