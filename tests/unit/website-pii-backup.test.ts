/**
 * Issue #151 — the website-data leads volume (plaintext PII) in the
 * backup guidance (audit WD-11).
 *
 * The honest split this suite pins, in two halves:
 *
 * VERIFIED STATE (passes on main before #151 — pins what issue #199
 * already shipped, so a REGRESSION of the shipped coverage is caught):
 *   · mjengo-backup.sh tars the website-data volume by default
 *     (MJENGO_WEBSITE_DIR default + MJENGO_BACKUP_WEBSITE=1 + the
 *     `backup_volume website` call) under a PII-tight umask 077;
 *   · the env example documents the volume path + its PII nature;
 *   · §6.3's retention warning cross-references the scheduled backup;
 *   · §7.2.2's backup-set list names the volume and the
 *     only-surviving-copy-of-early-leads warning.
 *
 * THE DELTA (the #151 acceptance criteria — all failed on main):
 *   · "a working backup command": §7.2's manual ad-hoc path now carries
 *     the website-data one-liner (`docker compose exec -T website tar
 *     -C /app/data -cf - . > website-data-$(date +%F).tar`) plus a
 *     host-side variant — and the `-T` is pinned WITH its rationale
 *     (compose exec allocates a TTY by default; a TTY corrupts a piped
 *     binary stream);
 *   · "cadence tied to the 500-cap": §7.2.1's cadence note states the
 *     lead-loss bound and "at least as often as your §6.3 retrieval
 *     cadence";
 *   · "PII note": §7.2.1's PII note carries Kenya DPA 2019 handling —
 *     retention-as-expiry, narrow access, live-file-first erasure
 *     (grounded in SECURITY.md's existing Data Protection Act
 *     reference);
 *   · testing requirement: §7.2.2's verify step reads submissions.json
 *     back through the site's own path.
 *
 * UPDATE (issue #362 / MD-3): the store's PII fields are now sealed at
 * rest with AES-256-GCM under CONTACT_PII_KEY, so the archive carries
 * ciphertext, not plaintext — the env example's PII-nature pin moved
 * from 'plaintext PII' to the encrypted-at-rest + key-custody wording
 * (the crypto itself, the route's fail-closed posture and the
 * decrypt/seal CLI are pinned by tests/unit/website-contact-pii.test.ts;
 * this file keeps owning the BACKUP-guidance pins).
 *
 * AND the issue's testing requirement executed for real, as far as a
 * Docker-less sandbox can take it (the same honest posture as the #199
 * drill doc and the #214 js-yaml stand-in): the documented tar pipeline
 * itself runs — a realistic submissions.json is archived with the exact
 * flags the doc command uses, the archive is LISTED (it must contain
 * submissions.json), extracted into a fresh "volume", and compared
 * byte-identical and parsed back as JSON, for both the exec form
 * (-cf, the §7.2 one-liner) and the gzip form (-czf, the host-side
 * variant and the scheduled script). The `docker compose exec -T`
 * wrapper is the operator's step, deliberately left to them.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DEPLOYMENT = readFileSync(`${REPO_ROOT}/DEPLOYMENT.md`, 'utf8')
const SCRIPT = readFileSync(`${REPO_ROOT}/deploy/backup/mjengo-backup.sh`, 'utf8')
const ENV_EXAMPLE = readFileSync(`${REPO_ROOT}/deploy/backup/mjengo-backup.env.example`, 'utf8')

/** One §-section of DEPLOYMENT.md, sliced by its headings (fails as '' if renamed). */
const section = (from: string, to: string): string => {
  const start = DEPLOYMENT.indexOf(from)
  const end = DEPLOYMENT.indexOf(to)
  return start === -1 || end === -1 || end < start ? '' : DEPLOYMENT.slice(start, end)
}
/** Prose pins are matched against whitespace-flattened text (markdown
 *  wraps lines arbitrarily; the sentences being pinned must not). */
const flat = (s: string): string => s.replace(/\s+/g, ' ')
const s72 = flat(section('### 7.2 Health, backups, secrets', '#### 7.2.1'))
const s721 = flat(section('#### 7.2.1', '#### 7.2.2'))
const s722 = flat(section('#### 7.2.2 Restore runbook', '### 7.3 '))

// ------------------------------------------------- verified state (#199)

describe('the #199 script already backs the volume up (verified state)', () => {
  it('mjengo-backup.sh tars the website-data volume, on by default', () => {
    // The issue predates #199: the SCHEDULED path covers the volume via
    // MJENGO_WEBSITE_DIR + MJENGO_BACKUP_WEBSITE=1 + the backup_volume
    // call. If any of the three rots, the PII volume silently leaves
    // the backup set — that is the exact WD-11 failure mode.
    expect(SCRIPT).toContain('MJENGO_WEBSITE_DIR:=/var/lib/docker/volumes/mjengo-os_website-data/_data')
    expect(SCRIPT).toContain('MJENGO_BACKUP_WEBSITE:=1')
    expect(SCRIPT).toContain('backup_volume website "$MJENGO_WEBSITE_DIR"')
  })

  it('the script writes PII-tight artifacts (umask 077 → 0600 files)', () => {
    expect(SCRIPT).toContain('umask 077')
    expect(SCRIPT).toContain('backups contain PII')
  })

  it('the env example ships the volume path + its (now encrypted) PII nature', () => {
    expect(ENV_EXAMPLE).toContain('MJENGO_WEBSITE_DIR=/var/lib/docker/volumes/mjengo-os_website-data/_data')
    // Issue #362: the store is sealed at rest — the pin moved from the
    // old 'plaintext PII' to the encrypted-at-rest + key-custody truth.
    expect(ENV_EXAMPLE).toContain('ENCRYPTED AT REST')
    expect(ENV_EXAMPLE).toContain('CONTACT_PII_KEY')
    expect(ENV_EXAMPLE).toContain('ciphertext without that key')
  })

  it("§6.3's retention warning cross-references the scheduled backup", () => {
    expect(flat(DEPLOYMENT)).toContain('The scheduled backup (§7.2.1) includes this volume')
  })

  it("§7.2.2's backup-set list names the volume + the only-surviving-copy warning", () => {
    expect(s722).toContain('`website-data` → `mjengo-website-<TS>.tar.gz`')
    expect(s722).toContain('submissions.json')
    expect(s722).toContain('ONLY surviving copy of early leads')
    // Issue #362: the entry is sealed-at-rest ciphertext now, and the
    // key-custody rule (never in the backup dir) ships with it.
    expect(s722).toContain('sealed under `CONTACT_PII_KEY`')
  })
})

// ------------------------------------- the #151 delta (the issue's ACs)

describe('the manual ad-hoc path (AC: a working backup command)', () => {
  it("§7.2 documents the website-data one-liner with -T", () => {
    expect(s72).toContain(
      'docker compose exec -T website tar -C /app/data -cf - . > website-data-$(date +%F).tar',
    )
  })

  it('plus the host-side variant for known mountpoints', () => {
    expect(s72).toContain(
      'tar -C /var/lib/docker/volumes/<project>_website-data/_data -czf website-data-$(date +%F).tar.gz .',
    )
  })

  it('the -T ships with its rationale (a compose-exec TTY corrupts the tar)', () => {
    // A future editor "simplifying" the flag away reintroduces a silent
    // corruption: the TTY newline translation mangles the binary stream.
    expect(s72).toContain('allocates a TTY by default')
    expect(s72).toContain('corrupts the tar')
  })
})

describe('cadence tied to the 500-cap (AC: cadence guidance)', () => {
  it("§7.2.1 states the lead-loss bound + 'at least as often as your retrieval cadence'", () => {
    expect(s721).toContain('500 most recent')
    expect(s721).toContain('at least as often')
    expect(s721).toContain('§6.3 retrieval cadence')
    // the burst that outruns daily backups is the one case where a lead
    // exists in NO backup — the cap log line is the operator's signal
    expect(s721).toContain('submission cap reached')
  })
})

describe('PII handling (AC: the PII note, with the Kenya DPA 2019 angle)', () => {
  it('§7.2.1 PII note: DPA framing, retention-as-expiry, access, erasure', () => {
    expect(s721).toContain('Kenya Data Protection Act 2019')
    expect(s721).toContain('SECURITY.md') // grounded in the repo's own DPA reference
    expect(s721).toContain('PII expiry') // retention bounded by design
    expect(s721).toContain('system of record') // erasure hits the live file first
    expect(s721).toContain('0600') // artifacts written PII-tight
  })
})

describe('restore + read-back (issue testing requirement)', () => {
  it("§7.2.2's verify step reads the leads back through the site's own path", () => {
    expect(s722).toContain('docker compose exec website cat /app/data/submissions.json')
    expect(s722).toContain('parse as JSON')
  })
})

// ------------------- the documented command, executed (Docker-less drill)

/** Realistic leads payload — the route's exact shape, pretty-printed 2-space. */
const LEADS = [
  {
    id: 'sub_lx8z1k_a1b2c3',
    ts: '2026-09-26T08:14:02.104Z',
    source: 'contact',
    name: 'Amina Njeri',
    email: 'amina@example.co.ke',
    phone: '+254712345678',
    message: 'Need a perimeter wall quote in Kiambu.',
  },
  {
    id: 'sub_lx9pq2_d4e5f6',
    ts: '2026-09-26T09:02:55.741Z',
    source: 'demo',
    name: 'Brian Otieno',
    email: 'brian@example.com',
    organization: 'Otieno Contractors',
    role: 'contractor',
    projectType: 'residential',
  },
  {
    id: 'sub_lxa3m7_g7h8i9',
    ts: '2026-09-26T10:47:19.930Z',
    source: 'contact',
    name: 'Cynthia Wanjiku',
    email: 'cynthia@example.co.ke',
    country: 'Kenya',
    message: 'Follow-up on the Karen roof estimate.',
  },
]

const scratch = mkdtempSync(join(tmpdir(), 'mjengo-151-'))
const volumeDir = join(scratch, 'website-data') // stands in for /app/data
const freshVolume = join(scratch, 'website-data-restored') // the "fresh volume"
const plainTar = join(scratch, 'website-data-2026-09-26.tar') // the exec-form name
const gzTar = join(scratch, 'website-data-2026-09-26.tar.gz') // the host/script form

beforeAll(() => {
  // Loud, self-explaining failure if the environment lacks tar — the
  // documented command is tar; a suite that skips silently pins nothing.
  execFileSync('tar', ['--version'], { stdio: 'ignore' })
  mkdirSync(volumeDir)
  writeFileSync(join(volumeDir, 'submissions.json'), JSON.stringify(LEADS, null, 2))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('the documented tar pipeline round-trips submissions.json', () => {
  it('exec form (§7.2 one-liner): archives, lists, restores byte-identical', () => {
    // `docker compose exec -T website tar -C /app/data -cf - . > …tar`
    // — everything except the docker wrapper, with the exact flags:
    const archive = execFileSync('tar', ['-C', volumeDir, '-cf', '-', '.'])
    writeFileSync(plainTar, archive)

    // the issue's verify ask: the archive CONTAINS submissions.json
    const listing = execFileSync('tar', ['-tf', plainTar], { encoding: 'utf8' })
    expect(listing).toContain('submissions.json')

    // §7.2.2 step 3's form, into a fresh volume:
    mkdirSync(freshVolume, { recursive: true })
    execFileSync('tar', ['-C', freshVolume, '-xf', plainTar])

    const original = readFileSync(join(volumeDir, 'submissions.json'))
    const restored = readFileSync(join(freshVolume, 'submissions.json'))
    expect(restored.equals(original), 'the restored file must be byte-identical').toBe(true)
  })

  it('gzip form (host-side variant + the scheduled script): same round-trip', () => {
    // `tar -C <volume> -czf …tar.gz .` → `tar -tzf` → `tar -xzf`
    execFileSync('tar', ['-C', volumeDir, '-czf', gzTar, '.'])
    const listing = execFileSync('tar', ['-tzf', gzTar], { encoding: 'utf8' })
    expect(listing).toContain('submissions.json')

    const restoreDir = join(scratch, 'website-data-restored-gz')
    mkdirSync(restoreDir)
    execFileSync('tar', ['-C', restoreDir, '-xzf', gzTar])
    const restored = readFileSync(join(restoreDir, 'submissions.json'))
    expect(restored.equals(readFileSync(join(volumeDir, 'submissions.json')))).toBe(true)
  })

  it('the restored file is the JSON the site reads back (entry count + newest ts)', () => {
    // "restores into a fresh volume with the site reading it back" —
    // the site's read path is JSON.parse of exactly this file (route.ts).
    const parsed = JSON.parse(readFileSync(join(freshVolume, 'submissions.json'), 'utf8'))
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(LEADS.length)
    expect(parsed[parsed.length - 1].ts).toBe('2026-09-26T10:47:19.930Z')
    expect(parsed[0]).toMatchObject({ name: 'Amina Njeri', email: 'amina@example.co.ke' })
  })
})
