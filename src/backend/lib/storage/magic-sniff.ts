// Magic-number sniffing (register SEC-8 — "Upload confirm lacks magic-number
// sniff"): the shared, dependency-free table that answers "what do these
// bytes ACTUALLY look like?" for every file type this app accepts or names
// in an honest refusal. Node builtins only (node:buffer) — no file-type
// dependency, no guessing.
//
// The consumers:
//   · /api/upload/confirm (the presigned client-direct flow) — the key's
//     server-minted extension names the expected type; the stored object's
//     FIRST bytes must carry that type's magic number or the confirm is
//     refused. The declared Content-Type is advisory everywhere in this flow
//     (the SigV4 presign covers host only), so the BYTES are the only
//     non-liar in the room.
//   · any future seam that needs the same honesty (the documents module's
//     sniffDocumentMime / sniffImageMime predate this table and stay as-is —
//     their behavior is pinned; consolidating them onto this table is a
//     follow-up, not this fix).
//
// COVERAGE (at least the audit table's ask):
//   JPEG  FF D8 FF
//   PNG   89 50 4E 47
//   WEBP  "RIFF" + bytes 8..12 "WEBP"
//   PDF   "%PDF-"
//   GIF   "GIF8" (GIF87a / GIF89a)
//   HEIC/HEIF  ISO-BMFF "ftyp" box whose major brand (bytes 8..12) is
//              heic/heix (HEIC) or mif1/msf1 (generic HEIF)
//
// HONESTY RULE: null means "no recognized type" — never a guess, never a
// fallback to the declared type. Callers turn null into specific refusals.

/** How many leading bytes a sniff needs at most (the HEIC/WEBP ftyp forms). */
export const MAGIC_SNIFF_PREFIX_BYTES = 16

/** The file types this table can name. */
export type SniffedMagicType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'application/pdf'
  | 'image/heic'
  | 'image/heif'

/** latin1 (binary) slice equality — the idiom for ASCII magic constants. */
function asciiAt(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('latin1')
}

/**
 * Sniff the leading bytes. Returns the recognized type or null when the bytes
 * match nothing in the table — including when the buffer is EMPTY or the
 * header is TRUNCATED (shorter than the candidate signature), because a
 * truncated header proves nothing about the file it came from.
 */
export function sniffMagicBytes(buf: Buffer): SniffedMagicType | null {
  // PNG — 89 50 4E 47 (first 4 of the 8-byte signature; same depth as the
  // documents module's sniffer).
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  // JPEG — FF D8 FF.
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  // WEBP — a RIFF container whose bytes 8..12 name WEBP (needs 12).
  if (buf.length >= 12 && asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  // PDF — "%PDF-" (needs 5).
  if (buf.length >= 5 && asciiAt(buf, 0, 5) === '%PDF-') {
    return 'application/pdf'
  }
  // GIF — "GIF87a"/"GIF89a"; 6 bytes so a bare "GIF8" is a truncated header,
  // not a GIF.
  if (buf.length >= 6 && asciiAt(buf, 0, 6).startsWith('GIF8')) {
    return 'image/gif'
  }
  // HEIC/HEIF — an ISO-BMFF "ftyp" box (bytes 4..8) whose major brand
  // (bytes 8..12) marks an Apple still-image container. Other brands
  // (isom/mp42/… — videos, system files) are NOT ours to claim: null.
  if (buf.length >= 12 && asciiAt(buf, 4, 8) === 'ftyp') {
    const brand = asciiAt(buf, 8, 12)
    if (brand === 'heic' || brand === 'heix') return 'image/heic'
    if (brand === 'mif1' || brand === 'msf1') return 'image/heif'
  }
  return null
}
