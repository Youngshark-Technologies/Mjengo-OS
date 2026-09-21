// Land & Property module — service layer (domain logic).
//
// Called from src/backend/actions/land.ts (never directly from a route):
//   - create/update parcels and set honest record status (searching/verified/flagged)
//   - attach parcel documents (v1 = metadata + transcription only, no binary
//     upload: storageKey is a deterministic recorded path)
//   - request a registry title search, receive the registry result
//   - transcription-vs-registry consistency check (document extractedText vs
//     search resultSummary → consistent / mismatch / pending; mismatch is an
//     anomaly FLAG for human review, never an accusation)
//   - review a received search; a human "accept" of a CONSISTENT result with
//     ≥1 document on file marks the parcel verified (record state, not a
//     government claim)
//
// Every mutation returns a plain object; lib/mjengo.ts applyAction() writes the
// AuditEvent automatically — never log manually here.

import { db } from '@/backend/lib/db'
import { randomIntInclusive } from '@/shared/ids'
import { PARCEL_STATUSES, PARCEL_DOCUMENT_KINDS } from './types'

// ---------------- input helpers ----------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function optNum(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function dateOrNull(v: unknown): Date | null {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

async function getParcel(projectId: string, parcelId: string) {
  const parcel = await db.landParcel.findFirst({
    where: { id: parcelId, projectId },
    include: {
      documents: { orderBy: { createdAt: 'desc' } },
      searches: { orderBy: { createdAt: 'desc' } },
    },
  })
  if (!parcel) throw new Error('Parcel not found in this project')
  return parcel
}

/** Notification to the client surface on land events that need their eyes. */
async function notifyClient(projectId: string, title: string, body: string) {
  const project = await db.project.findUnique({ where: { id: projectId } })
  await db.notification.create({
    data: { projectId, kind: 'land', title, body, recipient: project?.client ?? null, audienceRole: 'client' },
  })
}

// ---------------- transcription-vs-registry consistency check ----------------
//
// DETERMINISTIC, DOCUMENTED (no AI, no heuristics beyond string comparison):
//
//   1. No title-deed document on the parcel (or its extractedText is empty)
//      → "pending" — there is no transcription to compare against.
//   2. Normalize both texts: lowercase, keep [a-z0-9/] and collapse whitespace.
//   3. PLOT CHECK — extract the numeric core of the parcel's plotNumber
//      (e.g. "LR No. 2090/1234" → "2090/1234"). If the normalized registry
//      result does not contain it → "mismatch" (the plot number is the
//      strongest identifier; a missing plot is the loudest anomaly).
//   4. PROPRIETOR CHECK — from the deed transcription capture the name phrase
//      after "Registered proprietor" (a run of initials like "J. K." and/or
//      words like "Mwangi", stopping at the first non-name character), strip
//      parentheticals like "(transcribed)", and keep alphabetic tokens of
//      length ≥ 3 (initials such as "J. K." are ignored — they are not
//      distinctive). The check passes when:
//        a) any proprietor token appears in the normalized registry result, OR
//        b) the registry result itself asserts agreement ("proprietor
//           matches" / "matches the deed") — the official-search phrasing.
//      Otherwise → "mismatch".
//   5. No plot core AND no proprietor tokens could be extracted → "pending"
//      (nothing comparable was found — honest, not a fake "consistent").
//   6. All performed checks pass → "consistent".
//
// A "mismatch" is an anomaly flag for human review. It is never an accusation.

export interface MatchOutcome {
  verdict: 'pending' | 'consistent' | 'mismatch'
  reason: string
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "LR No. 2090/1234" → "2090/1234" (numeric core with slash intact). */
function plotCore(plotNumber: string): string | null {
  const m = plotNumber.match(/\d+\s*\/\s*\d+/)
  return m ? m[0].replace(/\s+/g, '') : null
}

/** Meaningful proprietor tokens from a deed transcription (initials ignored). */
function proprietorTokens(deedText: string): string[] {
  // Name phrase = a run of initials ("J. K.") and/or words ("Mwangi"),
  // stopping at the first non-name character (period, parenthesis, comma…).
  const m = deedText.match(
    /registered\s+proprietor[^:.\n]{0,40}[:\n]\s*((?:[A-Za-z]{1,2}\.\s*|[A-Za-z][A-Za-z'-]{2,}\s*)+)/i,
  )
  if (!m) return []
  const name = m[1].replace(/\([^)]*\)/g, ' ')
  return name.toLowerCase().match(/[a-z]{3,}/g) ?? []
}

export function computeTranscriptionMatch(
  deedText: string | null,
  resultSummary: string,
  plotNumber: string,
): MatchOutcome {
  if (!deedText || !deedText.trim()) {
    return { verdict: 'pending', reason: 'No title-deed transcription on file — nothing to compare against yet' }
  }
  const summaryNorm = normalizeText(resultSummary)
  const checks: string[] = []

  // 3. plot check
  const core = plotCore(plotNumber)
  if (core) {
    if (!summaryNorm.includes(core)) {
      return {
        verdict: 'mismatch',
        reason: `Plot number ${core} is not found in the registry result`,
      }
    }
    checks.push(`plot number ${core} found`)
  }

  // 4. proprietor check
  const tokens = proprietorTokens(deedText)
  if (tokens.length) {
    const found = tokens.some((t) => summaryNorm.includes(t))
    const assertsAgreement = /proprietor matches|matches the deed/.test(summaryNorm)
    if (!found && !assertsAgreement) {
      return {
        verdict: 'mismatch',
        reason: `Registry proprietor differs from the deed transcription (${tokens.join(' / ')})`,
      }
    }
    checks.push(found ? 'proprietor name matches' : 'registry asserts the proprietor matches')
  }

  // 5. nothing comparable extracted
  if (!checks.length) {
    return {
      verdict: 'pending',
      reason: 'No plot number or proprietor could be extracted from the deed transcription — nothing comparable',
    }
  }

  return { verdict: 'consistent', reason: checks.join('; ') }
}

// ---------------- parcel lifecycle ----------------

/** Record a new parcel — starts in the honest SEARCHING record state. */
export async function createParcel(projectId: string, payload: Record<string, unknown>) {
  const plotNumber = str(payload.plotNumber)
  if (!plotNumber) throw new Error('Plot number required (e.g. "LR No. 2090/1234")')
  const county = str(payload.county)
  if (!county) throw new Error('County required')

  const lat = optNum(payload.latitude)
  const lng = optNum(payload.longitude)
  if (lat !== null && (lat < -90 || lat > 90)) throw new Error('Latitude must be between -90 and 90')
  if (lng !== null && (lng < -180 || lng > 180)) throw new Error('Longitude must be between -180 and 180')

  const dupe = await db.landParcel.findFirst({ where: { projectId, plotNumber } })
  if (dupe) throw new Error('A parcel with this plot number is already recorded on the project')

  const parcel = await db.landParcel.create({
    data: {
      projectId,
      plotNumber,
      county,
      town: str(payload.town),
      lat,
      lng,
      approxArea: str(payload.approxArea),
      tenureType: str(payload.tenureType),
      status: 'searching',
    },
  })
  return { id: parcel.id, plotNumber: parcel.plotNumber, status: parcel.status }
}

/** Update parcel particulars (identity fields only — status has its own action). */
export async function updateParcel(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Parcel id required')
  await getParcel(projectId, id)

  const data: {
    plotNumber?: string
    county?: string
    town?: string | null
    approxArea?: string | null
    tenureType?: string | null
    lat?: number
    lng?: number
  } = {}

  const plotNumber = str(payload.plotNumber)
  if (plotNumber) {
    const dupe = await db.landParcel.findFirst({ where: { projectId, plotNumber, NOT: { id } } })
    if (dupe) throw new Error('Another parcel with this plot number is already recorded on the project')
    data.plotNumber = plotNumber
  }
  const county = str(payload.county)
  if (county) data.county = county
  if ('town' in payload) data.town = str(payload.town)
  if ('approxArea' in payload) data.approxArea = str(payload.approxArea)
  if ('tenureType' in payload) data.tenureType = str(payload.tenureType)

  const lat = optNum(payload.latitude)
  if (lat !== null) {
    if (lat < -90 || lat > 90) throw new Error('Latitude must be between -90 and 90')
    data.lat = lat
  }
  const lng = optNum(payload.longitude)
  if (lng !== null) {
    if (lng < -180 || lng > 180) throw new Error('Longitude must be between -180 and 180')
    data.lng = lng
  }

  if (!Object.keys(data).length) throw new Error('Nothing to update — no recognized fields supplied')
  const parcel = await db.landParcel.update({ where: { id }, data })
  return { id: parcel.id, plotNumber: parcel.plotNumber }
}

/** Set the honest record status (searching / verified / flagged) with a note for the trail. */
export async function setParcelStatus(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Parcel id required')
  const status = str(payload.status)
  if (!status || !(PARCEL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`status must be one of: ${PARCEL_STATUSES.join(', ')}`)
  }
  const note = str(payload.note)
  const parcel = await getParcel(projectId, id)
  await db.landParcel.update({ where: { id }, data: { status } })

  // The note rides the notification trail (the audit event records the action itself)
  if (note || status === 'flagged') {
    await notifyClient(
      projectId,
      `Land record: ${parcel.plotNumber} marked ${status}`,
      note
        ? `${note} — record state, not a government certification.`
        : 'Status set without a note — consider adding one via the record status action.',
    )
  }
  return { id, status }
}

// ---------------- documents ----------------

/**
 * Attach a document to a parcel (v1: metadata + transcription only — no binary
 * upload; storageKey is the deterministic recorded path the file WILL live at).
 */
export async function attachParcelDocument(projectId: string, payload: Record<string, unknown>) {
  const parcelId = str(payload.parcelId)
  if (!parcelId) throw new Error('parcelId required')
  await getParcel(projectId, parcelId)

  const kind = str(payload.kind)
  if (!kind || !(PARCEL_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of: ${PARCEL_DOCUMENT_KINDS.join(', ')}`)
  }
  const fileName = str(payload.fileName)
  if (!fileName) throw new Error('File name required')
  const extractedText = str(payload.extractedText)
  const issuedOn = dateOrNull(payload.issuedOn)

  const storageKey = `/documents/${projectId}/${fileName.replace(/[^a-zA-Z0-9._-]+/g, '_')}`
  const doc = await db.parcelDocument.create({
    data: { parcelId, kind, fileName, storageKey, extractedText, issuedOn },
  })
  return { id: doc.id, parcelId, kind, storageKey }
}

// ---------------- registry title searches ----------------

/** Request a registry title search — the search is REQUESTED, not confirmed. */
export async function requestTitleSearch(projectId: string, payload: Record<string, unknown>) {
  const parcelId = str(payload.parcelId)
  if (!parcelId) throw new Error('parcelId required')
  const parcel = await getParcel(projectId, parcelId)

  const open = parcel.searches.find((s) => s.status === 'requested')
  if (open) throw new Error('A registry search is already requested for this parcel — receive its result first')

  // MD-4 (#350): the generated search ref draws its six digits from the
  // shared CSPRNG seam (src/shared/ids.ts) — the CS/YYYY/NNNNNN public shape
  // is preserved, the draw is no longer Math.random (predictable).
  const searchRef =
    str(payload.searchRef) ?? `CS/${new Date().getFullYear()}/${randomIntInclusive(100000, 999999)}`
  const search = await db.titleSearch.create({
    data: { parcelId, searchRef, status: 'requested', transcriptionMatch: 'pending' },
  })
  return { id: search.id, searchRef, parcelId }
}

/**
 * Receive the registry result and run the transcription-consistency check.
 * The result is RECORDED (typed/transcribed by a person) — MjengoOS is not a
 * registry and does not confirm anything.
 */
export async function receiveTitleSearch(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Search id required')
  const resultSummary = str(payload.resultSummary)
  if (!resultSummary) throw new Error('resultSummary required — paste what the registry returned')

  const search = await db.titleSearch.findUnique({ where: { id }, include: { parcel: true } })
  if (!search || search.parcel.projectId !== projectId) throw new Error('Search not found in this project')
  if (search.status !== 'requested') throw new Error('This search already has a received result')

  const deed = await db.parcelDocument.findFirst({
    where: { parcelId: search.parcelId, kind: 'title_deed', extractedText: { not: null } },
    orderBy: { createdAt: 'desc' },
  })
  const outcome = computeTranscriptionMatch(deed?.extractedText ?? null, resultSummary, search.parcel.plotNumber)

  const updated = await db.titleSearch.update({
    where: { id },
    data: {
      status: 'received',
      resultSummary,
      transcriptionMatch: outcome.verdict,
      receivedAt: new Date(),
    },
  })

  if (outcome.verdict === 'mismatch') {
    await notifyClient(
      projectId,
      `Land record: review required — ${search.parcel.plotNumber}`,
      `The registry result differs from the deed transcription (${outcome.reason}). This is an anomaly flag for human review, not an accusation.`,
    )
  }
  return { id: updated.id, transcriptionMatch: outcome.verdict, reason: outcome.reason }
}

/**
 * Mark a received search as reviewed (human decision):
 *   · accept — a CONSISTENT search with ≥1 document on file promotes the
 *     parcel to VERIFIED (record state: documents + registry result agree)
 *   · flag   — the parcel is set FLAGGED for follow-up by the professionals
 */
export async function reviewTitleSearch(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Search id required')
  const decision = str(payload.decision)
  if (decision !== 'accept' && decision !== 'flag') throw new Error("decision must be 'accept' or 'flag'")
  const note = str(payload.note)

  const search = await db.titleSearch.findUnique({ where: { id }, include: { parcel: true } })
  if (!search || search.parcel.projectId !== projectId) throw new Error('Search not found in this project')
  if (search.status !== 'received') throw new Error('Only a RECEIVED search can be marked reviewed')

  await db.titleSearch.update({ where: { id }, data: { status: 'reviewed', reviewedAt: new Date() } })
  const parcel = await getParcel(projectId, search.parcelId)

  let parcelStatus = parcel.status
  if (decision === 'flag') {
    parcelStatus = 'flagged'
    await db.landParcel.update({ where: { id: parcel.id }, data: { status: 'flagged' } })
    await notifyClient(
      projectId,
      `Land record: flagged — ${parcel.plotNumber}`,
      note
        ? `${note} — flagged for professional follow-up.`
        : 'Search reviewed and flagged for professional follow-up.',
    )
  } else if (search.transcriptionMatch === 'consistent' && parcel.documents.length >= 1) {
    // Verified = record state: documents on file + a reviewed, consistent search.
    // It is NOT a government certification.
    parcelStatus = 'verified'
    await db.landParcel.update({ where: { id: parcel.id }, data: { status: 'verified' } })
    await notifyClient(
      projectId,
      `Land record: ${parcel.plotNumber} marked verified`,
      'Documents on file and the reviewed registry search agree — MjengoOS record state, not a government certification. Advocate review remains the legal step.',
    )
  } else {
    await notifyClient(
      projectId,
      `Land record: search reviewed — ${parcel.plotNumber}`,
      'Reviewed as accepted. The parcel stays SEARCHING until a consistent search and at least one document are on file.',
    )
  }
  return { id, decision, parcelId: parcel.id, parcelStatus }
}
