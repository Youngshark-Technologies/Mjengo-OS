#!/usr/bin/env node
// decrypt-leads — the operator's retrieval / re-seal path for the website's
// contact-form store (MD-3, issue #362).
//
// data/submissions.json rests SEALED (AES-256-GCM per PII field under
// CONTACT_PII_KEY — see ../lib/contact-pii.mjs). `cat` on the file shows
// the JSON structure and the plaintext id/ts/source, but the PII fields
// are `enc:v1:…` strings. THIS script is the documented way to read
// leads back and to write a corrected file back after an erasure edit
// (DEPLOYMENT.md §6.3):
//
//   # retrieve (compose — the key is already in the website container):
//   docker compose exec website node /app/scripts/decrypt-leads.mjs > leads.json
//
//   # retrieve (local dev, from mjengoos-website/ — `bun run` loads .env):
//   bun run decrypt-leads > ../leads.json
//
//   # erasure / correction write-back — decrypt, edit leads.json, then:
//   docker compose exec -T website sh -c \
//     'node /app/scripts/decrypt-leads.mjs --seal > /app/data/submissions.json' < leads.json
//
// Modes:
//   (default)  decrypt: read the store, open every sealed field, print the
//              plaintext JSON (2-space pretty, the store's own format) to
//              STDOUT. A field that fails to decrypt (wrong/rotated key,
//              tampering, a value moved between rows) keeps its sealed
//              value in the output, gets one stderr line with the reason,
//              and makes the exit code 1 — nothing is silently dropped or
//              invented. Entries still resting in plaintext (a legacy
//              pre-#362 row, or a fresh write-back) pass through readable
//              with a stderr note; the next form submission re-seals them.
//   --seal     seal: read plaintext-or-mixed JSON, seal every plaintext PII
//              field (already-sealed current-key values pass through
//              untouched), print the sealed JSON to STDOUT. The erasure
//              write-back uses this so the store never rests in plaintext
//              after an operator edit.
//
// Input: the first non-flag argument is the store path (default
// data/submissions.json relative to the CWD — /app/data/submissions.json
// in the container, mjengoos-website/data/ in dev); `-` reads STDIN.
// The script NEVER writes to the store itself — output goes to stdout, the
// operator redirects. Key: CONTACT_PII_KEY from the environment (same
// verdict as the route — unset+production or malformed refuses; unset
// elsewhere uses the labeled dev fallback with one stderr warning).
//
// Exit codes: 0 = requested output printed, everything verified;
// 1 = key refused, unreadable input, or (decrypt mode) any field that
// failed authentication.

import { readFileSync } from 'node:fs'
import process from 'node:process'

import {
  hasLegacyPlaintextContactPii,
  openContactSubmission,
  resolveContactPiiChannel,
  sealContactSubmission,
} from '../lib/contact-pii.mjs'

const USAGE = `usage: decrypt-leads.mjs [--seal] [path|-]

  (default)  decrypt the contact store to plaintext JSON on stdout
  --seal     seal plaintext JSON (or a mixed store) to sealed JSON on stdout
  path       input file (default data/submissions.json), or "-" for stdin

Examples (DEPLOYMENT.md §6.3):
  docker compose exec website node /app/scripts/decrypt-leads.mjs > leads.json
  bun run decrypt-leads > leads.json            # local dev, from mjengoos-website/
  docker compose exec -T website sh -c \\
    'node /app/scripts/decrypt-leads.mjs --seal > /app/data/submissions.json' < leads.json`

function fail(message) {
  process.stderr.write(`[decrypt-leads] ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
const seal = args.includes('--seal')
const positional = args.filter((a) => a !== '--seal')
if (positional.length > 1 || positional.some((a) => a.startsWith('-') && a !== '-')) {
  fail(`unexpected arguments: ${args.join(' ')}\n${USAGE}`)
}
const input = positional[0] ?? 'data/submissions.json'
if (input === '-' && process.stdin.isTTY) {
  fail(`"-" reads a piped store from stdin (there is a terminal attached instead)\n${USAGE}`)
}

// Same verdict as the route, resolved at call time; posture warnings
// (dev fallback / refusal) land on stderr via the shared module.
const channel = resolveContactPiiChannel()
if (channel.refused) {
  fail(
    'no usable CONTACT_PII_KEY — nothing in this store can be ' +
      (seal ? 'sealed' : 'decrypted') +
      ' (set it in the environment and retry; the contact form has the same posture, issue #362)',
  )
}

let raw
try {
  raw = input === '-' ? readFileSync(0, 'utf8') : readFileSync(input, 'utf8')
} catch (err) {
  fail(`cannot read ${input === '-' ? 'stdin' : input}: ${err instanceof Error ? err.message : String(err)}`)
}

let entries
try {
  entries = JSON.parse(raw)
} catch (err) {
  fail(`input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
}
if (!Array.isArray(entries)) {
  fail(`expected a JSON array of submissions (the store's shape), got ${typeof entries}`)
}

if (seal) {
  const sealedEntries = entries.map((entry) => sealContactSubmission(channel.key, entry))
  const legacy = entries.filter((entry) => hasLegacyPlaintextContactPii(entry)).length
  process.stdout.write(`${JSON.stringify(sealedEntries, null, 2)}\n`)
  if (legacy > 0) {
    process.stderr.write(
      `[decrypt-leads] sealed ${legacy} plaintext entr${legacy === 1 ? 'y' : 'ies'} ` +
        `(redirect this output into the store to complete the write-back)\n`,
    )
  }
  process.exit(0)
}

let failures = 0
const legacy = entries.filter((entry) => hasLegacyPlaintextContactPii(entry)).length
const openedEntries = entries.map((entry) => {
  const { entry: opened, failures: fieldFailures } = openContactSubmission(channel.key, entry)
  for (const { field, message } of fieldFailures) {
    failures += 1
    process.stderr.write(
      `[decrypt-leads] ${String(entry.id ?? '<no id>')}: field "${field}" failed: ${message} ` +
        `(sealed value left in place)\n`,
    )
  }
  return opened
})
process.stdout.write(`${JSON.stringify(openedEntries, null, 2)}\n`)
if (legacy > 0) {
  process.stderr.write(
    `[decrypt-leads] ${legacy} entr${legacy === 1 ? 'y holds' : 'ies hold'} plaintext fields — ` +
      `printed as-is; the next form submission (or --seal) seals them (issue #362)\n`,
  )
}
if (failures > 0) {
  process.stderr.write(`[decrypt-leads] ${failures} field${failures === 1 ? '' : 's'} failed to decrypt — see above\n`)
  process.exit(1)
}
process.exit(0)
