// POST /api/upload/confirm — step 2 of the client-direct upload flow
// (task 9-b). After PUTting bytes to the URL /api/upload/presign handed out,
// the client confirms: this route VERIFIES the object actually landed (HEAD
// via the storage driver — existence, size ≤ 4 MB, image Content-Type) and
// only then creates the Attachment row.
//
// VERIFICATION IS THE POINT: a presigned URL is bearer-only for a few
// minutes, but the ROW is the durable record — it must never describe an
// object that was never uploaded. Register SEC-8 closed the last gap here:
// HEAD metadata alone was trusted, and Content-Type on S3 is whatever the
// client's PUT carried (the presign response's headers told it exactly what
// to send, but nothing enforced it) — a renamed non-image wearing an
// image Content-Type used to confirm cleanly. The route now reads the
// FIRST bytes of the stored object back through the driver's readPrefix
// seam (a ranged GET / a prefix file read — never the whole object through
// the app) and requires the magic number to match the key's server-minted
// extension (sniffMagicBytes, src/backend/lib/storage/magic-sniff.ts). On
// mismatch — including empty and truncated-header objects — the row is
// refused with a specific explanation rather than created with a lie. The
// recorded mimeType is the byte-VERIFIED type, not the client's header.
//
// IDEMPOTENT ON THE NATURAL KEY (issue #159 / audit API-8): this is the
// S3/R2 deployment surface, and retries are EXPECTED there (that is why
// the presign family exists) — a retried confirm used to mint a second
// Attachment row pointing at one object. The dedupe key is the RAW object
// key (upp-<ts>-<hex>.<ext>), recorded on the row as Attachment.objectKey
// (unique index, migration 18) — NOT storageKey, which is publicUrl(key)
// and on s3-compat without S3_PUBLIC_BASE is a per-call presigned GET
// (fresh SigV4 date, 7-day expiry), so two confirms of one object would
// mint two different strings. The design is the natural-key route rather
// than the #177 IdempotencyRecord seam because the seam is check-then-act
// on a caller-chosen header key (confirm has none — the server minted the
// key) and cannot make the create safe under concurrency; only the DB
// constraint gives "concurrent double-confirm → one row". See migration
// 18's header for the full decision record.
//
// Replay semantics: a retried confirm of an already-confirmed key returns
// the ORIGINAL row (200, replayed: true — the wallet family's idiom),
// without re-HEADing the object: the row was minted after a successful
// verification, and the retry asks "did my confirm land?", which the row
// answers. The first confirm wins the provenance snapshot (uploadedBy,
// sizeBytes, mimeType, storageKey) — evidence rows are append-only, so a
// replay never rewrites them. A conflicting retry — same key, different
// category, the one caller-chosen payload field — is refused 409 without
// replaying or updating (the money family's payload-mismatch posture,
// issue #75/BE-9). Keys are minted per presign response and handed to
// exactly one session, so the single-column unique is honest: one object,
// one row, first confirm wins.
//
// The row matches the document-mode Attachment shape (reviewStatus 'pending'
// default, category provenance, sizeBytes/mimeType from the HEAD). Fields
// this flow does NOT take (projectId/entityType/entityId/expiresAt/title)
// are a deliberate scope cut — the document mode's richer provenance is its
// own route; photo provenance rides the delivery-verification links that
// consume attachment ids (agent 8-a).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/backend/lib/db'
import { route, genericError } from '@/backend/lib/route-kit'
import { getStorageDriver } from '@/backend/lib/storage'
import { MAGIC_SNIFF_PREFIX_BYTES, sniffMagicBytes } from '@/backend/lib/storage/magic-sniff'
import { DOCUMENT_CATEGORIES } from '@/backend/modules/documents/types'

const MAX_BYTES = 4 * 1024 * 1024 // same 4 MB cap as the photo path

/** The only keys this route will ever confirm — server-minted photo keys. */
const UPP_KEY_RE = /^upp-\d+-[a-f0-9]{6}\.(png|jpg)$/

const PHOTO_MIME_TYPES = new Set(['image/png', 'image/jpeg'])

/**
 * The byte-verified contract per server-minted key extension (SEC-8): the
 * presign route minted the extension from the declared contentType, so the
 * key — not the client's PUT headers — is the type this confirm proves
 * against the actual bytes.
 */
const KEY_EXT_MIME: Record<'png' | 'jpg', 'image/png' | 'image/jpeg'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
}

const confirmBody = z.strictObject({
  key: z
    .string('key must be a string')
    .regex(UPP_KEY_RE, {
      error: 'key must be a presigned-upload key (upp-<timestamp>-<hex>.png|jpg — from POST /api/upload/presign)',
    }),
  category: z.enum(DOCUMENT_CATEGORIES, {
    error: `category must be one of: ${DOCUMENT_CATEGORIES.join(', ')}`,
  }),
})

/**
 * Prisma P2002 raised by the Attachment.objectKey unique index (migration
 * 18) — the DB-level dedupe this route leans on. The engine reports the
 * violated target as the field list or the index name depending on
 * adapter/version, so both shapes are recognized; a P2002 naming anything
 * else (nothing else on this table is caller-reachable) is rethrown —
 * fail closed, never silently swallowed.
 */
function isObjectKeyUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, meta } = err as { code?: unknown; meta?: { target?: unknown } | null }
  if (code !== 'P2002') return false
  const target = meta?.target
  if (Array.isArray(target)) {
    return target.some((t) => String(t).includes('objectKey'))
  }
  if (typeof target === 'string') {
    return target.includes('objectKey') || target.includes('Attachment_objectKey_key')
  }
  return false
}

export const POST = route(
  {
    scope: 'api/upload/confirm',
    roles: ['contractor', 'admin', 'client'],
    rateLimit: { bucket: 'upload:confirm', limit: 10, windowMs: 60_000 },
    body: { schema: confirmBody, maxBytes: 64 * 1024 },
    onError: genericError(500, 'Confirm failed'),
  },
  async (_req, session, body) => {
    const { key, category } = body

    // The replay lookup runs BEFORE the storage verification: an existing
    // row for this objectKey is the durable answer to "did my confirm
    // land?" (it was minted after a successful HEAD), so a retry gets it
    // even if the object's HEAD would transiently fail now — and the
    // retry path skips the object round-trip entirely.
    const existing = await db.attachment.findUnique({ where: { objectKey: key } })
    if (existing) return replayOrConflict(existing, key, category)

    const driver = getStorageDriver()
    if (typeof driver.statObject !== 'function') {
      return NextResponse.json(
        {
          error:
            `Upload confirmation unavailable — storage driver "${driver.id}" ` +
            `cannot verify objects (server-mediated upload only)`,
        },
        { status: 409 },
      )
    }

    const stat = await driver.statObject(key)
    if (!stat.exists) {
      return NextResponse.json(
        {
          error:
            `No uploaded object for key "${key}" — PUT the file to the presigned ` +
            `URL first (POST /api/upload/presign), then confirm`,
        },
        { status: 404 },
      )
    }
    if (stat.sizeBytes !== null && stat.sizeBytes > MAX_BYTES) {
      return NextResponse.json(
        {
          error:
            `Uploaded object is ${(stat.sizeBytes / 1024 / 1024).toFixed(1)} MB — ` +
            `the limit is 4 MB; re-upload a compressed photo and confirm the new key`,
        },
        { status: 413 },
      )
    }
    if (stat.contentType && !PHOTO_MIME_TYPES.has(stat.contentType)) {
      return NextResponse.json(
        {
          error:
            `Uploaded object reports Content-Type "${stat.contentType}" — expected ` +
            `image/png or image/jpeg. Send the Content-Type header from the presign ` +
            `response with your PUT (it is not part of the signature, so the store ` +
            `kept whatever the PUT carried)`,
        },
        { status: 400 },
      )
    }

    // SEC-8 (magic-number sniff): everything above verified METADATA, and
    // metadata is client-shaped — the PUT's Content-Type is an advisory
    // header the store records verbatim. The row is the durable record, so
    // the BYTES get the final word: read the object's first bytes back
    // through the driver (a ranged GET on S3 — never the whole object
    // through the app) and require the magic number to match the type the
    // server-minted key promises. A driver that cannot read bytes back
    // cannot have its uploads content-verified — honest 409, fail closed.
    if (typeof driver.readPrefix !== 'function') {
      return NextResponse.json(
        {
          error:
            `Upload confirmation unavailable — storage driver "${driver.id}" ` +
            `cannot read object bytes back for content verification (magic-number sniff)`,
        },
        { status: 409 },
      )
    }

    const expectedMime = KEY_EXT_MIME[key.endsWith('.png') ? 'png' : 'jpg']
    const prefix = await driver.readPrefix(key, MAGIC_SNIFF_PREFIX_BYTES)
    if (prefix === null) {
      // HEAD saw the object, the read did not — vanished in between (or a
      // store that cannot serve it). The honest answer is "not confirmable
      // right now", not a row minted on stale metadata.
      return NextResponse.json(
        {
          error:
            `The uploaded object for key "${key}" could not be read back for content ` +
            `verification (present at HEAD time, absent on read) — retry the confirm, ` +
            `or re-upload (POST /api/upload/presign) and confirm the new key`,
        },
        { status: 404 },
      )
    }
    if (prefix.length === 0) {
      return NextResponse.json(
        {
          error:
            `Uploaded object for key "${key}" is empty (0 bytes) — expected ${expectedMime}; ` +
            `upload rejected. PUT real file bytes before confirming.`,
        },
        { status: 400 },
      )
    }
    const sniffed = sniffMagicBytes(prefix)
    if (sniffed !== expectedMime) {
      return NextResponse.json(
        {
          error:
            `File content does not match its type: key "${key}" expects ${expectedMime}, ` +
            `but the stored bytes look like ${
              sniffed ?? 'no recognized file type (PNG, JPEG, WebP, GIF, PDF, HEIC)'
            } — upload rejected. The Content-Type header is advisory; the bytes are the truth.`,
        },
        { status: 400 },
      )
    }

    // storageKey is the driver's PUBLIC URL (what the frontend renders, same
    // field semantics as every existing Attachment row). With S3_PUBLIC_BASE
    // it is stable forever; without it, it is a presigned GET with the SigV4
    // 7-day maximum — the documented tradeoff (DEPLOYMENT.md object storage
    // section; replay-time re-signing is the parked follow-up). objectKey is
    // the RAW key — the stable natural key the unique index (migration 18)
    // dedupes on, so the unstable publicUrl above never gates idempotency.
    let attachment
    try {
      attachment = await db.attachment.create({
        data: {
          entityType: 'photo',
          entityId: 'unattached',
          fileName: key,
          storageKey: driver.publicUrl(key),
          objectKey: key,
          kind: `${category}_photo`,
          uploadedBy: session.user.email,
          projectId: null,
          category,
          // SEC-8: the byte-VERIFIED type (=== expectedMime by the sniff
          // above), never the client-declared HEAD value — the row describes
          // what the bytes proved to be.
          mimeType: expectedMime,
          sizeBytes: stat.sizeBytes,
          reviewStatus: 'pending', // the existing upload default — humans review
        },
      })
    } catch (err) {
      // Concurrent double-confirm: both requests missed the replay lookup
      // above, both passed verification, and the unique index made exactly
      // one create win. The loser resolves the winner's row and replays it
      // — both callers get 200, one row exists. Any other error is not
      // ours to interpret: rethrow (the route's 500 contract).
      if (!isObjectKeyUniqueViolation(err)) throw err
      const winner = await db.attachment.findUnique({ where: { objectKey: key } })
      if (!winner) throw err // vanished between violation and re-read — honest 500
      return replayOrConflict(winner, key, category)
    }

    return NextResponse.json({
      ok: true,
      replayed: false,
      attachment: {
        id: attachment.id,
        storageKey: attachment.storageKey,
        fileName: attachment.fileName,
        category: attachment.category,
        reviewStatus: attachment.reviewStatus,
      },
    })
  },
)

/**
 * The shared answer for a key that is already confirmed — both the
 * pre-verification replay lookup and the post-race unique-violation path.
 * Same category → 200 with the ORIGINAL row and the family's replayed flag
 * (the row is never rewritten — append-only evidence). Different category
 * (the one caller-chosen payload field) → 409, nothing replayed, nothing
 * updated: reusing a confirmed key to reclassify the upload is a client
 * bug, and silently honouring it would fork the caller's intent from the
 * recorded evidence.
 */
function replayOrConflict(
  existing: {
    id: string
    storageKey: string
    fileName: string
    category: string | null
    reviewStatus: string
  },
  key: string,
  category: (typeof DOCUMENT_CATEGORIES)[number],
): NextResponse {
  if (existing.category !== category) {
    return NextResponse.json(
      {
        error:
          `Upload key "${key}" was already confirmed as category "${existing.category ?? 'none'}" — ` +
          `the stored Attachment was NOT replayed and NOT reclassified. Confirm again with the ` +
          `original category, or presign a fresh upload (POST /api/upload/presign) for "${category}".`,
      },
      { status: 409 },
    )
  }
  return NextResponse.json({
    ok: true,
    replayed: true,
    attachment: {
      id: existing.id,
      storageKey: existing.storageKey,
      fileName: existing.fileName,
      category: existing.category,
      reviewStatus: existing.reviewStatus,
    },
  })
}
