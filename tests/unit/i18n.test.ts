/**
 * i18n dictionary invariants (src/frontend/i18n — W4-I18N).
 *
 * The app ships English + Kiswahili dicts that are compile-time asserted to
 * carry the same key set (dicts/check.ts), but that guard only runs under
 * `tsc --noEmit` and the runtime dev guard only console.warns. These tests
 * fail the build when:
 *   · a key is added to one dictionary and forgotten in the other;
 *   · a component calls t() with a literal key no dictionary knows
 *     (sampled: settings-tab — the biggest consumer — plus the nav surface,
 *     and the W7 field-surface files: use-mjengo, sync-outbox-panel,
 *     materials/fundis/money/share — issue #79);
 *   · the canonical TAB_META navigation labels drift from the dicts (a
 *     missing tab label renders a raw key string in the navbar);
 *   · the {var} placeholder SET of a key drifts between en and sw (a
 *     translation that drops {name} would render the literal "{name}");
 *   · a W7 field-surface file regresses to a raw English toast literal
 *     instead of a t() call (the "no English toast on the field path"
 *     acceptance of issue #79);
 *   · the uikit fallbacks (ErrorBoundary crash card + DataTable empty/aria
 *     defaults) resolve the uikit.* dict keys, carry no raw English, and the
 *     crash card keeps reading the locale provider-free (issue #152).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate, translateForLocale } from '@/frontend/i18n/provider'
import { TAB_META } from '@/frontend/mjengo/nav/tab-meta'
import { ALL_TABS, KNOWN_ROLES, ROLE_LABELS } from '@/shared/permissions'

const enKeys = new Set(Object.keys(enDict))
const swKeys = new Set(Object.keys(swDict))

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

describe('en/sw dictionaries carry the exact same key set', () => {
  it('sw is missing nothing that en has', () => {
    const missing = [...enKeys].filter((k) => !swKeys.has(k))
    expect(missing, 'keys missing from sw.ts').toEqual([])
  })

  it('en is missing nothing that sw has', () => {
    const missing = [...swKeys].filter((k) => !enKeys.has(k))
    expect(missing, 'keys missing from en.ts').toEqual([])
  })

  it('every value in both dictionaries is a non-empty string', () => {
    for (const [k, v] of Object.entries(enDict)) {
      expect(typeof v === 'string' && v.trim().length > 0, `en.${k}`).toBe(true)
    }
    for (const [k, v] of Object.entries(swDict)) {
      expect(typeof v === 'string' && v.trim().length > 0, `sw.${k}`).toBe(true)
    }
  })
})

describe('navigation: every tab renders a label in both languages', () => {
  it('TAB_META covers exactly the tab universe (no orphan tabs, no dead meta)', () => {
    expect([...new Set(TAB_META.map((m) => m.key))].sort()).toEqual([...ALL_TABS].sort())
  })

  it('every full label key exists in both dictionaries', () => {
    for (const meta of TAB_META) {
      expect(enKeys.has(meta.label), `en is missing nav label "${meta.label}"`).toBe(true)
      expect(swKeys.has(meta.label), `sw is missing nav label "${meta.label}"`).toBe(true)
    }
  })

  it('every compact mobile label key exists in both dictionaries', () => {
    for (const meta of TAB_META) {
      expect(enKeys.has(meta.shortLabel), `en is missing short label "${meta.shortLabel}"`).toBe(true)
      expect(swKeys.has(meta.shortLabel), `sw is missing short label "${meta.shortLabel}"`).toBe(true)
    }
  })
})

describe('settings tab: every literal t() key resolves in both dictionaries', () => {
  const settingsSrc = readFileSync(
    fileURLToPath(new URL('../../src/frontend/mjengo/settings-tab.tsx', import.meta.url)),
    'utf8',
  )
  // Literal keys: t('settings.title'), t("login.email"), … (template-literal
  // dynamic keys are covered separately below).
  const literalKeys = [
    ...settingsSrc.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...settingsSrc.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  it('the sample actually found keys (guard against a silent regex drift)', () => {
    expect(literalKeys.length).toBeGreaterThan(20)
  })

  it('every sampled key exists in both dictionaries', () => {
    expect(literalKeys.length).toBeGreaterThan(0)
    for (const key of new Set(literalKeys)) {
      expect(enKeys.has(key), `en.ts is missing "${key}" (used by settings-tab)`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}" (used by settings-tab)`).toBe(true)
    }
  })

  it("dynamic t(`role.${role}`) keys exist for every role the UI can render", () => {
    const roleKeySource = [...Object.keys(ROLE_LABELS), ...KNOWN_ROLES]
    for (const role of new Set(roleKeySource)) {
      expect(enKeys.has(`role.${role}`), `en.ts is missing dynamic key "role.${role}"`).toBe(true)
      expect(swKeys.has(`role.${role}`), `sw.ts is missing dynamic key "role.${role}"`).toBe(true)
    }
    expect(enKeys.has('role.unknown')).toBe(true)
    expect(swKeys.has('role.unknown')).toBe(true)
  })
})

describe('en/sw values carry the same {var} placeholder set (issue #79)', () => {
  const placeholders = (s: string) =>
    [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',')

  it('every key interpolates the same vars in both languages', () => {
    for (const [k, v] of Object.entries(enDict)) {
      expect(placeholders(v), `en.${k} placeholder set`).toBe(placeholders(swDict[k]))
    }
    for (const [k, v] of Object.entries(swDict)) {
      expect(placeholders(v), `sw.${k} placeholder set`).toBe(placeholders(enDict[k]))
    }
  })
})

describe('W7 field surface (issue #79): every literal t() key resolves in both dictionaries', () => {
  // use-mjengo.ts uses a store-level t() (locale read imperatively) — the
  // literal-key sampling below covers it like any component.
  const FIELD_SURFACE_FILES = [
    'src/frontend/hooks/use-mjengo.ts',
    'src/frontend/mjengo/sync-outbox-panel.tsx',
    'src/frontend/mjengo/materials-tab.tsx',
    'src/frontend/mjengo/fundis-tab.tsx',
    'src/frontend/mjengo/share-dialog.tsx',
    'src/frontend/mjengo/money-tab.tsx',
  ] as const

  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  it('the samples actually found keys (guard against a silent regex drift)', () => {
    for (const file of FIELD_SURFACE_FILES) {
      const keys = literalKeysIn(readSrc(file))
      expect(keys.length, `${file} sampled no t() keys`).toBeGreaterThan(4)
    }
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const file of FIELD_SURFACE_FILES) {
      for (const key of new Set(literalKeysIn(readSrc(file)))) {
        expect(enKeys.has(key), `en.ts is missing "${key}" (used by ${file})`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}" (used by ${file})`).toBe(true)
      }
    }
  })
})

describe('W7 field surface (issue #79): no raw English toast literals on the field path', () => {
  // A toast whose first argument starts with a quote is a raw string; a
  // template literal is tolerated ONLY when it starts with ${t( (the
  // aiReview.runFailed pattern). Variable/server passthroughs (json.error,
  // msg, ternaries around t()) are fine by construction.
  const RAW_TOAST = /toast\.(?:success|error|info|warning)\(\s*(?:['"]|`(?!\$\{t\())/g

  it('component files render every toast through t()', () => {
    const files = [
      'src/frontend/mjengo/sync-outbox-panel.tsx',
      'src/frontend/mjengo/materials-tab.tsx',
      'src/frontend/mjengo/fundis-tab.tsx',
      'src/frontend/mjengo/share-dialog.tsx',
      'src/frontend/mjengo/money-tab.tsx',
    ]
    for (const file of files) {
      const offending = [...readSrc(file).matchAll(RAW_TOAST)].map(() => file)
      expect(offending, `${file} still fires raw-literal toasts`).toEqual([])
    }
  })

  it('the W7 sync/dispatch toasts exist in both dictionaries (use-mjengo store-level t())', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    for (const key of [
      'sync.backOnlineDraining', 'sync.backOnlineConflicts', 'sync.backOnline',
      'sync.doneConflicts', 'sync.doneFailed', 'sync.doneOk', 'sync.retrying',
      'sync.readOnlyClient',
    ]) {
      expect(src.includes(`t('${key}'`), `use-mjengo.ts no longer uses ${key}`).toBe(true)
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })

  it('interpolates {vars} through the real translate() in both languages', () => {
    expect(translate(enDict, 'field.savedQueued', { count: 2 })).toBe('Saved on-device — queued (2)')
    expect(translate(swDict, 'field.savedQueued', { count: 2 })).toBe('Imehifadhiwa kwenye kifaa — (2) zinangojea kusawazishwa')
    expect(translate(enDict, 'sync.serverRefused', { reason: 'stale version' })).toBe('Server refused: stale version')
    expect(translate(swDict, 'sync.serverRefused', { reason: 'toleo la zamani' })).toBe('Seva imekataa: toleo la zamani')
  })
})

// ---------------------------------------------------------------------------
// #107 Kiswahili completion wave (audit FE-1/FE-6): the newly wired surfaces.
// Same literal-key sampling convention as the W7 field-surface block above —
// every literal t('…') key a wired file calls must resolve in BOTH dicts, and
// the dynamic enum-key families (land labels, intel severity) are pinned by
// enumerating the backend enum values they render.
// ---------------------------------------------------------------------------

describe('#107 wave: finder / intel / land surfaces — every literal t() key resolves in both dictionaries', () => {
  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  // Key-carrying object literals (TEMPLATES / tiles / options pattern) are
  // captured by scanning for the quoted namespace strings too.
  const namespaceStringsIn = (src: string) =>
    [...src.matchAll(/'(finder|intel|land)\.[a-zA-Z0-9_.]+'/g)].map((m) => m[0].slice(1, -1))

  const WAVE_SURFACES: Record<string, string[]> = {
    finder: [
      'src/frontend/mjengo/finder/sections/dashboard-section.tsx',
      'src/frontend/mjengo/finder/sections/search-section.tsx',
      'src/frontend/mjengo/finder/sections/requests-section.tsx',
      'src/frontend/mjengo/finder/sections/requests/request-card.tsx',
      'src/frontend/mjengo/finder/sections/requests/bits.tsx',
      'src/frontend/mjengo/finder/sections/search/bits.tsx',
    ],
    intel: [
      'src/frontend/mjengo/intel/bits.tsx',
      'src/frontend/mjengo/intel/sections/risk-section.tsx',
      'src/frontend/mjengo/intel/sections/digest-section.tsx',
      'src/frontend/mjengo/intel/sections/prices-section.tsx',
      'src/frontend/mjengo/intel/sections/reliability-section.tsx',
      'src/frontend/mjengo/intel/sections/suggestions-section.tsx',
      'src/frontend/mjengo/intel/sections/jobs-section.tsx',
    ],
    land: [
      'src/frontend/mjengo/land-tab.tsx',
      'src/frontend/mjengo/land/labels.ts',
      'src/frontend/mjengo/land/sections/parcels-section.tsx',
      'src/frontend/mjengo/land/sections/parcels/badges.tsx',
      'src/frontend/mjengo/land/sections/parcels/parcel-card.tsx',
      'src/frontend/mjengo/land/sections/parcels/parcel-detail.tsx',
      'src/frontend/mjengo/land/sections/parcels/property-passport.tsx',
      'src/frontend/mjengo/land/sections/parcels/timeline.tsx',
    ],
    dialogs: [
      'src/frontend/mjengo/create-project-dialog.tsx',
      'src/frontend/mjengo/expense-dialog.tsx',
      'src/frontend/mjengo/worker-dialogs.tsx',
    ],
    shell: [
      'src/frontend/mjengo/app.tsx',
      'src/frontend/mjengo/diaspora-banner.tsx',
    ],
  }

  it('each surface family samples enough keys (guards against silent wiring regressions)', () => {
    const minimums: Record<string, number> = { finder: 60, intel: 45, land: 80, dialogs: 60, shell: 8 }
    for (const [family, files] of Object.entries(WAVE_SURFACES)) {
      const keys = new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))
      expect(keys.size, `${family} surface sampled too few keys (${keys.size})`).toBeGreaterThan(minimums[family])
    }
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const [family, files] of Object.entries(WAVE_SURFACES)) {
      for (const key of new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))) {
        expect(enKeys.has(key), `en.ts is missing "${key}" (used by the ${family} surface)`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}" (used by the ${family} surface)`).toBe(true)
      }
    }
  })

  it('no raw English toast literals on the newly wired finder/intel path', () => {
    const RAW_TOAST = /toast\.(?:success|error|info|warning)\(\s*(?:['"]|`(?!\$\{t\())/g
    const files = [...WAVE_SURFACES.finder, ...WAVE_SURFACES.intel]
    for (const file of files) {
      const offending = [...readSrc(file).matchAll(RAW_TOAST)].map(() => file)
      expect(offending, `${file} still fires raw-literal toasts`).toEqual([])
    }
  })
})

describe('#107 wave: dynamic enum label keys exist for every renderable value', () => {
  // land/labels.ts renders t(`land.parcelStatus.${status}`) etc. — the enums
  // live in the backend type modules and are pinned here so a new enum value
  // cannot ship without its en+sw label keys.
  const PARCEL_STATUSES = ['searching', 'verified', 'flagged']
  const MATCHES = ['pending', 'consistent', 'mismatch']
  const SEARCH_STATUSES = ['requested', 'received', 'reviewed']
  const DOC_KINDS = ['title_deed', 'search_cert', 'survey_map', 'other']
  const ASSIGN_ROLES = ['surveyor', 'advocate', 'engineer', 'qty_surveyor']
  const ASSIGN_STATUSES = ['invited', 'active', 'done', 'completed', 'withdrawn']
  const PRO_CATEGORIES = ['surveyor', 'advocate', 'engineer', 'qty_surveyor', 'architect', 'contractor']
  const LICENCE_BODIES = ['LSK', 'EBK', 'BORAQS', 'other']
  const CHECK_METHODS = ['document_review', 'reference_call', 'registry_lookup']
  const SEVERITIES = ['info', 'warning', 'critical']

  const expectBoth = (key: string) => {
    expect(enKeys.has(key), `en.ts is missing dynamic key "${key}"`).toBe(true)
    expect(swKeys.has(key), `sw.ts is missing dynamic key "${key}"`).toBe(true)
  }

  it('land enum labels resolve in both dictionaries', () => {
    PARCEL_STATUSES.forEach((s) => expectBoth(`land.parcelStatus.${s}`))
    PARCEL_STATUSES.forEach((s) => expectBoth(`land.parcelStatus.${s}.title`))
    MATCHES.forEach((m) => expectBoth(`land.match.${m}`))
    MATCHES.forEach((m) => expectBoth(`land.match.${m}.title`))
    SEARCH_STATUSES.forEach((s) => expectBoth(`land.searchStatus.${s}`))
    SEARCH_STATUSES.forEach((s) => expectBoth(`land.searchStatus.${s}.title`))
    DOC_KINDS.forEach((k) => expectBoth(`land.docKind.${k}`))
    ASSIGN_ROLES.forEach((r) => expectBoth(`land.assignRole.${r}`))
    ASSIGN_STATUSES.forEach((s) => expectBoth(`land.assignStatus.${s}`))
    PRO_CATEGORIES.forEach((c) => expectBoth(`land.proCategory.${c}`))
    LICENCE_BODIES.forEach((b) => expectBoth(`land.licenceBody.${b}`))
    CHECK_METHODS.forEach((m) => expectBoth(`land.checkMethod.${m}`))
    for (let level = 0; level <= 6; level++) {
      expectBoth(`land.ladder.${level}.label`)
      expectBoth(`land.ladder.${level}.hint`)
    }
  })

  it('intel severity labels resolve in both dictionaries', () => {
    SEVERITIES.forEach((s) => expectBoth(`intel.severity.${s}`))
  })
})

describe('#107 wave: onboarding-critical strings + client-facing copy', () => {
  it('share dead-link / network errors render through the dict (FE-6, issue #108)', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(src.includes("t('share.error.invalid')")).toBe(true)
    expect(src.includes("t('share.error.network')")).toBe(true)
    expect(enKeys.has('share.error.invalid')).toBe(true)
    expect(swKeys.has('share.error.invalid')).toBe(true)
    expect(enKeys.has('share.error.network')).toBe(true)
    expect(swKeys.has('share.error.network')).toBe(true)
    expect(src).not.toContain("'This share link is invalid or has been revoked'")
    expect(src).not.toContain("'Could not reach MjengoOS — check your connection'")
  })

  it('client banner + footer render through the dict (banner.* / footer.*)', () => {
    for (const key of [
      'banner.preview', 'banner.exit', 'banner.exitAria', 'banner.client',
      'footer.client.tagline', 'footer.client.siteTeam', 'footer.client.siteTeamAria',
      'footer.owner.tagline', 'footer.owner.copilot', 'footer.owner.payments', 'footer.owner.location',
    ]) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })

  it('the core dialogs translate their validation errors (spot values via the real translate())', () => {
    expect(translate(enDict, 'dialog.createProject.error.budget')).toBe('Budget must be greater than 0')
    expect(translate(swDict, 'dialog.createProject.error.budget')).toBe('Bajeti lazima iwe zaidi ya 0')
    expect(translate(enDict, 'dialog.expense.error.amount')).toBe('Amount must be greater than 0')
    expect(translate(swDict, 'dialog.expense.error.amount')).toBe('Kiasi lazima kiwe zaidi ya 0')
    expect(translate(swDict, 'dialog.createProject.toastOk')).toBe('Mradi umetengenezwa — karibu kazi!')
    expect(translate(swDict, 'land.parcels.record')).toBe('Rekodi kiwanja')
    expect(translate(swDict, 'finder.search.find')).toBe('Tafuta wasambazaji')
    expect(translate(swDict, 'intel.risk.title')).toBe('Hatari ya mradi')
  })
})

// ---------------------------------------------------------------------------
// #107 Kiswahili wave 5 (4-d-2): the four partially-covered tab bodies —
// materials / fundis / money / evidence — so ALL 13 tabs render Kiswahili
// under locale=SW. Same conventions as the wave-1..4 block above: every
// literal t('…') key (plus quoted namespace strings in key-carrying object
// literals like MOVEMENT_TYPES/tiles) must resolve in BOTH dicts, the
// enum-key families (movement types, attendance statuses, verification
// levels) are pinned by enumerating their values, and raw-literal toasts
// are banned on the newly wired path.
// ---------------------------------------------------------------------------

describe('#107 wave 5: tab bodies — every literal t() key resolves in both dictionaries', () => {
  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  const namespaceStringsIn = (src: string) =>
    [...src.matchAll(/'(mat|fundis|money|evidence|ev)\.[a-zA-Z0-9_.]+'/g)].map((m) => m[0].slice(1, -1))

  const WAVE5_SURFACES: Record<string, string[]> = {
    materials: ['src/frontend/mjengo/materials-tab.tsx'],
    fundis: ['src/frontend/mjengo/fundis-tab.tsx'],
    money: ['src/frontend/mjengo/money-tab.tsx'],
    evidence: ['src/frontend/mjengo/evidence-tab.tsx'],
  }

  it('each wave-5 surface samples enough keys (guards against silent wiring regressions)', () => {
    const minimums: Record<string, number> = { materials: 90, fundis: 80, money: 200, evidence: 60 }
    for (const [family, files] of Object.entries(WAVE5_SURFACES)) {
      const keys = new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))
      expect(keys.size, `${family} surface sampled too few keys (${keys.size})`).toBeGreaterThan(minimums[family])
    }
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const [family, files] of Object.entries(WAVE5_SURFACES)) {
      for (const key of new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))) {
        expect(enKeys.has(key), `en.ts is missing "${key}" (used by the ${family} tab)`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}" (used by the ${family} tab)`).toBe(true)
      }
    }
  })
})

describe('#107 wave 5: fundis enum label keys exist for every renderable value', () => {
  // fundis-tab renders t(`fundis.status.${s}`) for the four attendance
  // statuses (display copy; STATUS_LABELS stays EN for dispatch labels) and
  // t(`fundis.verif.${v}`) for the three verification levels.
  const STATUSES = ['present', 'half_day', 'absent', 'excused']
  const VERIFICATIONS = ['verified', 'reported', 'exception']

  const expectBoth = (key: string) => {
    expect(enKeys.has(key), `en.ts is missing dynamic key "${key}"`).toBe(true)
    expect(swKeys.has(key), `sw.ts is missing dynamic key "${key}"`).toBe(true)
  }

  it('attendance status + verification labels resolve in both dictionaries', () => {
    STATUSES.forEach((s) => expectBoth(`fundis.status.${s}`))
    VERIFICATIONS.forEach((v) => expectBoth(`fundis.verif.${v}`))
  })

  it('fundis labels render Kiswahili under sw (spot values via the real translate())', () => {
    expect(translate(swDict, 'fundis.status.half_day')).toBe('Nusu siku')
    expect(translate(swDict, 'fundis.verif.verified')).toBe('Imethibitishwa')
    expect(translate(swDict, 'fundis.count.exception', { count: 3 })).toBe('3 Utata')
    expect(translate(swDict, 'fundis.gate.desc', { count: 2, amount: 'KSh 5,000', review: 'KSh 3,000' }))
      .toBe('rekodi 2 zinahitaji uthibitisho kabla ya mishahara — KSh 5,000 zimesimama (KSh 3,000 zinasubiri ukaguzi).')
    // STATUS_LABELS keeps feeding dispatch labels in English (audit data).
    const src = readSrc('src/frontend/mjengo/fundis-tab.tsx')
    expect(src).toContain("half_day: 'Half day'")
    expect(src).not.toContain('STATUS_LABELS[to] ??')
  })
})

describe('#107 wave 5: materials enum label keys exist for every renderable value', () => {
  // MOVEMENT_TYPES (form values) and MOVEMENT_LABELS (stored
  // StockMovementType values) render through dict keys — pinned here so a
  // new enum value cannot ship without its en+sw labels.
  const FORM_MOVEMENTS = ['opening', 'received', 'consumed', 'transfer', 'return', 'damage', 'adjust']
  const STORED_MOVEMENTS = [
    'opening', 'received', 'consumed', 'transferred_in', 'transferred_out',
    'returned', 'damaged', 'adjusted',
  ]

  const expectBoth = (key: string) => {
    expect(enKeys.has(key), `en.ts is missing dynamic key "${key}"`).toBe(true)
    expect(swKeys.has(key), `sw.ts is missing dynamic key "${key}"`).toBe(true)
  }

  it('movement form + stored-enum labels resolve in both dictionaries', () => {
    FORM_MOVEMENTS.forEach((m) => expectBoth(`mat.movement.${m}`))
    STORED_MOVEMENTS.forEach((m) => expectBoth(`mat.mtype.${m}`))
    FORM_MOVEMENTS.forEach((m) => expectBoth(`mat.toastLbl.${m}`))
  })

  it('movement labels render Kiswahili under sw (spot values via the real translate())', () => {
    expect(translate(swDict, 'mat.movement.return')).toBe('Kurudisha kwa msambazaji')
    expect(translate(swDict, 'mat.mtype.transferred_out')).toBe('Imehamishwa nje')
    expect(translate(swDict, 'mat.toastLbl.transfer', { qty: 10, unit: 'begi', name: 'Saruji', to: 'Slab store' }))
      .toBe('Imehamishwa 10 begi Saruji → Slab store')
    expect(translate(swDict, 'mat.unknownSupplier')).toBe('Msambazaji asiyejulikana')
    // 'Site Store' is a stored proper noun — it stays untranslated in BOTH.
    expect(translate(swDict, 'mat.store.title')).toBe('Site Store')
    expect(translate(enDict, 'mat.store.title')).toBe('Site Store')
  })
})

// ---------------------------------------------------------------------------
// #123 (audit FE-2): simulated-rails posture banner. The Money tab surface
// banner and the fundis payroll gate line share ONE key family
// (money.posture.*) — pinned here so the disclosure cannot ship in one
// language only, and so the copy stays honest (ledger-real,
// provider-simulated, #43) via the real translate().
// ---------------------------------------------------------------------------

describe('#123: posture banner key family exists in both dictionaries', () => {
  const POSTURE_KEYS = [
    'money.posture.title',
    'money.posture.note',
    'money.posture.dismiss',
    'money.posture.dismissAria',
  ] as const

  it('the shared money.posture.* family resolves in BOTH dictionaries', () => {
    for (const key of POSTURE_KEYS) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })

  it('the posture copy states the honest ledger-real / provider-simulated posture in both languages', () => {
    expect(translate(enDict, 'money.posture.title')).toBe('Simulated money rails')
    expect(translate(enDict, 'money.posture.note')).toContain('double-entry ledger')
    expect(translate(enDict, 'money.posture.note')).toContain('simulated')
    expect(translate(enDict, 'money.posture.note')).toContain('#43')
    expect(translate(swDict, 'money.posture.title')).toBe('Njia za pesa za mfano')
    expect(translate(swDict, 'money.posture.note')).toContain('daftari halisi la mara mbili')
    expect(translate(swDict, 'money.posture.note')).toContain('mfano')
    expect(translate(swDict, 'money.posture.note')).toContain('#43')
  })
})

// ---------------------------------------------------------------------------
// #363 / audit MD-8 — the zero-VAT invoice note (finder.inv.vatNote): ONE
// shared key rendered by every invoice surface that shows totals (detail
// dialog, printable record, tab list, decision-queue card, pay/create
// dialogs, supplier portal, CSV export — the per-surface wiring is pinned in
// invoice-vat-labeling.test.ts, along with the posture seam that gates it).
// ---------------------------------------------------------------------------

describe('#363: the zero-VAT note states the honest posture in both languages', () => {
  it('EN names the posture, the pending configuration and the totals fact', () => {
    expect(translate(enDict, 'finder.inv.vatNote')).toContain('VAT is not applied')
    expect(translate(enDict, 'finder.inv.vatNote')).toContain('tax configuration is pending')
    expect(translate(enDict, 'finder.inv.vatNote')).toContain('totals include no VAT')
  })

  it('SW renders the Kiswahili twin (same claims, no raw English fallback)', () => {
    expect(translate(swDict, 'finder.inv.vatNote')).toContain('VAT haijatumika')
    expect(translate(swDict, 'finder.inv.vatNote')).toContain('bado unasubiri')
    expect(translate(swDict, 'finder.inv.vatNote')).toContain('jumla hazijumuishi VAT')
  })

  it('both cite MD-8 (the audit register row tracking the deferred VAT work)', () => {
    expect(translate(enDict, 'finder.inv.vatNote')).toContain('(MD-8)')
    expect(translate(swDict, 'finder.inv.vatNote')).toContain('(MD-8)')
  })
})

// ---------------------------------------------------------------------------
// #125 Kiswahili surface completion (audit FE-3): audit tab, finder invoices/
// requests/dashboard/search, land dialogs + professionals, overview cards,
// shell cards, and the report/CSV artifacts. Same conventions as the blocks
// above (literal-key sampling, enum-family pinning, raw-toast bans) — plus
// the regression guard the issue itself asks for: every file the 2026-09-16
// baseline listed as EN-only must now import useT. The USSD tab body was
// deliberately absent until #140 closed FE-9 (see the #140 blocks below).
// ---------------------------------------------------------------------------

describe('#125: every baseline EN-only surface now imports useT (regression guard)', () => {
  // The definitive FE-3 list (register row FE-3, resolved via #125; rg -L useT)
  // — artifacts (report-utils.ts / export-utils.ts) are pure functions that
  // TAKE t() instead of calling the hook, so they are pinned by signature in
  // the artifacts block below, not by the useT import.
  const BASELINE_EN_ONLY_FILES = [
    'src/frontend/mjengo/audit-tab.tsx',
    // finder — invoices
    'src/frontend/mjengo/finder/sections/invoices-section.tsx',
    'src/frontend/mjengo/finder/sections/invoices/create-invoice-dialog.tsx',
    'src/frontend/mjengo/finder/sections/invoices/decision-queue-card.tsx',
    'src/frontend/mjengo/finder/sections/invoices/invoice-bits.tsx',
    'src/frontend/mjengo/finder/sections/invoices/invoice-detail-dialog.tsx',
    'src/frontend/mjengo/finder/sections/invoices/ledger-consistency-chip.tsx',
    'src/frontend/mjengo/finder/sections/invoices/pay-invoice-dialog.tsx',
    'src/frontend/mjengo/finder/sections/invoices/printable-invoice.tsx',
    // finder — requests
    'src/frontend/mjengo/finder/sections/requests/quotes-card.tsx',
    'src/frontend/mjengo/finder/sections/requests/order-card.tsx',
    'src/frontend/mjengo/finder/sections/requests/create-order-dialog.tsx',
    'src/frontend/mjengo/finder/sections/requests/create-request-dialog.tsx',
    'src/frontend/mjengo/finder/sections/requests/delivery-receive-dialog.tsx',
    'src/frontend/mjengo/finder/sections/requests/delivery-photos.tsx',
    // finder — dashboard + search
    'src/frontend/mjengo/finder/sections/dashboard/boq-card.tsx',
    'src/frontend/mjengo/finder/sections/dashboard/rules-card.tsx',
    'src/frontend/mjengo/finder/sections/dashboard/price-alert-chip.tsx',
    'src/frontend/mjengo/finder/sections/search/supplier-directory.tsx',
    // land
    'src/frontend/mjengo/land/sections/parcels/dialogs.tsx',
    'src/frontend/mjengo/land/sections/professionals-section.tsx',
    'src/frontend/mjengo/land/sections/professionals/dialogs.tsx',
    'src/frontend/mjengo/land/sections/professionals/professional-card.tsx',
    'src/frontend/mjengo/land/sections/professionals/assignments-summary.tsx',
    'src/frontend/mjengo/land/sections/professionals/verification-ladder.tsx',
    // overview
    'src/frontend/mjengo/overview/role-cards.tsx',
    'src/frontend/mjengo/overview/timeline.tsx',
    'src/frontend/mjengo/overview/variance-card.tsx',
    // shell / cards
    'src/frontend/mjengo/map-view.tsx',
    'src/frontend/mjengo/project-switcher.tsx',
    'src/frontend/mjengo/photo-comments.tsx',
    'src/frontend/mjengo/site-map-card.tsx',
    'src/frontend/mjengo/timelapse-card.tsx',
    // #140 closed FE-9: the USSD tab body (LCD script, keypad aria-labels,
    // explainer, demo-PIN list) — pinned by the #140 blocks below.
    'src/frontend/mjengo/ussd-tab.tsx',
  ] as const

  it.each(BASELINE_EN_ONLY_FILES)('%s wires useT()', (file) => {
    expect(readSrc(file), `${file} lost its useT import — the exact FE-3 gap class`).toContain('useT')
  })

  it('the guard list itself stays wired (no silently dropped entries)', () => {
    expect(BASELINE_EN_ONLY_FILES.length).toBeGreaterThanOrEqual(34)
  })
})

describe('#125: audit + finder + land + overview + shell — every literal t() key resolves in both dictionaries', () => {
  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  // Key-carrying object literals + template-literal families resolved by
  // these surfaces (the pattern the #107 wave block uses).
  const namespaceStringsIn = (src: string) =>
    [...src.matchAll(/'(audit|finder|land|overview|map|switcher|comments|sitemap|tl|fundis)\.[a-zA-Z0-9_.]+'/g)]
      .map((m) => m[0].slice(1, -1))

  const SURFACES_125: Record<string, string[]> = {
    audit: ['src/frontend/mjengo/audit-tab.tsx'],
    finderInvoices: [
      'src/frontend/mjengo/finder/sections/invoices-section.tsx',
      'src/frontend/mjengo/finder/sections/invoices/create-invoice-dialog.tsx',
      'src/frontend/mjengo/finder/sections/invoices/decision-queue-card.tsx',
      'src/frontend/mjengo/finder/sections/invoices/invoice-bits.tsx',
      'src/frontend/mjengo/finder/sections/invoices/invoice-detail-dialog.tsx',
      'src/frontend/mjengo/finder/sections/invoices/ledger-consistency-chip.tsx',
      'src/frontend/mjengo/finder/sections/invoices/pay-invoice-dialog.tsx',
      'src/frontend/mjengo/finder/sections/invoices/printable-invoice.tsx',
    ],
    finderRequests: [
      'src/frontend/mjengo/finder/sections/requests/quotes-card.tsx',
      'src/frontend/mjengo/finder/sections/requests/order-card.tsx',
      'src/frontend/mjengo/finder/sections/requests/create-order-dialog.tsx',
      'src/frontend/mjengo/finder/sections/requests/create-request-dialog.tsx',
      'src/frontend/mjengo/finder/sections/requests/delivery-receive-dialog.tsx',
      'src/frontend/mjengo/finder/sections/requests/delivery-photos.tsx',
    ],
    finderDashboard: [
      'src/frontend/mjengo/finder/sections/dashboard/boq-card.tsx',
      'src/frontend/mjengo/finder/sections/dashboard/rules-card.tsx',
      'src/frontend/mjengo/finder/sections/dashboard/price-alert-chip.tsx',
      'src/frontend/mjengo/finder/sections/search/supplier-directory.tsx',
    ],
    land: [
      'src/frontend/mjengo/land/sections/parcels/dialogs.tsx',
      'src/frontend/mjengo/land/sections/professionals-section.tsx',
      'src/frontend/mjengo/land/sections/professionals/dialogs.tsx',
      'src/frontend/mjengo/land/sections/professionals/professional-card.tsx',
      'src/frontend/mjengo/land/sections/professionals/assignments-summary.tsx',
      'src/frontend/mjengo/land/sections/professionals/verification-ladder.tsx',
    ],
    overview: [
      'src/frontend/mjengo/overview/role-cards.tsx',
      'src/frontend/mjengo/overview/timeline.tsx',
      'src/frontend/mjengo/overview/variance-card.tsx',
    ],
    shell: [
      'src/frontend/mjengo/map-view.tsx',
      'src/frontend/mjengo/project-switcher.tsx',
      'src/frontend/mjengo/photo-comments.tsx',
      'src/frontend/mjengo/site-map-card.tsx',
      'src/frontend/mjengo/timelapse-card.tsx',
    ],
  }

  it('each #125 surface family samples enough keys (guards against silent wiring regressions)', () => {
    const minimums: Record<string, number> = {
      audit: 40, finderInvoices: 120, finderRequests: 90, finderDashboard: 60,
      land: 150, overview: 80, shell: 60,
    }
    for (const [family, files] of Object.entries(SURFACES_125)) {
      const keys = new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))
      expect(keys.size, `${family} surface sampled too few keys (${keys.size})`).toBeGreaterThan(minimums[family])
    }
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const [family, files] of Object.entries(SURFACES_125)) {
      for (const key of new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))) {
        expect(enKeys.has(key), `en.ts is missing "${key}" (used by the ${family} surface)`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}" (used by the ${family} surface)`).toBe(true)
      }
    }
  })

  it('no raw English toast literals on the newly wired #125 path', () => {
    const RAW_TOAST = /toast\.(?:success|error|info|warning)\(\s*(?:['"]|`(?!\$\{t\())/g
    const files = Object.values(SURFACES_125).flat()
    for (const file of files) {
      const offending = [...readSrc(file).matchAll(RAW_TOAST)].map(() => file)
      expect(offending, `${file} still fires raw-literal toasts`).toEqual([])
    }
  })
})

describe('#125: dynamic enum label keys exist for every renderable value', () => {
  const PRO_CATEGORIES_FULL = ['surveyor', 'engineer', 'advocate', 'architect', 'qty_surveyor', 'contractor']
  const FUNDIS_DISPATCH = [
    'checkIn', 'checkOut', 'override', 'record', 'muster', 'exception', 'addFundi', 'editFundi',
  ]

  const expectBoth = (key: string) => {
    expect(enKeys.has(key), `en.ts is missing dynamic key "${key}"`).toBe(true)
    expect(swKeys.has(key), `sw.ts is missing dynamic key "${key}"`).toBe(true)
  }

  it('the professionals body-hint family covers every category the add-dialog can select', () => {
    PRO_CATEGORIES_FULL.forEach((c) => expectBoth(`land.pros.dlg.bodyHint.${c}`))
  })

  it('the verification-ladder caption family (checks count + aria) resolves in both dictionaries', () => {
    expectBoth('land.ladder.aria')
    expectBoth('land.ladder.rungTitle')
    expectBoth('land.ladder.current')
    expectBoth('land.ladder.checksOne')
    expectBoth('land.ladder.checksMany')
    for (let level = 0; level <= 6; level++) expectBoth(`land.ladder.${level}.label`)
  })

  it('the fundis dispatch-label family exists in both dictionaries', () => {
    FUNDIS_DISPATCH.forEach((k) => expectBoth(`fundis.dispatch.${k}`))
  })

  it('spot Kiswahili values render through the real translate()', () => {
    expect(translate(swDict, 'land.dlg.np.title')).toBe('Rekodi kiwanja kipya')
    expect(translate(swDict, 'land.pros.card.noChecks')).toContain('Haijathibitishwa')
    expect(translate(swDict, 'land.ladder.checksMany', { n: 3 })).toBe('ukaguzi 3 umerekodiwa')
    expect(translate(swDict, 'overview.var.badge.over')).toBe('Imevuka bajeti')
    expect(translate(swDict, 'map.title')).toBe('Ramani ya wasambazaji na viwanja')
    expect(translate(swDict, 'switcher.newProject')).toBe('Mradi mpya')
    expect(translate(swDict, 'tl.day', { day: 4 })).toBe('Siku 4')
    expect(translate(swDict, 'fundis.dispatch.record', { name: 'Otieno', status: 'Yupo' })).toBe('Rekodi Otieno Yupo')
  })
})

describe('#125: dispatch STATUS_LABELS moved into the dicts (the old EN pin, flipped)', () => {
  // Wave-5 pinned STATUS_LABELS as EN "because it feeds dispatch labels".
  // #125 moves those dispatch labels through t(): the map above stays as a
  // KNOWN-STATUS GUARD only — its EN values never render anywhere.
  it('STATUS_LABELS is a guard; dispatch labels resolve the dict twins', () => {
    const src = readSrc('src/frontend/mjengo/fundis-tab.tsx')
    // guard usage (display path)
    expect(src).toContain('STATUS_LABELS[status] ? t(`fundis.status.${status}`)')
    // the dispatch label paths interpolate localized statuses
    expect(src).toContain("t('fundis.dispatch.override', { name: worker.name, status: t(`fundis.status.${to}`) })")
    expect(src).toContain("t('fundis.dispatch.record', { name: worker.name, status: t(`fundis.status.${to}`) })")
    // the old raw-EN interpolation is gone
    expect(src).not.toContain('STATUS_LABELS[to]')
  })
})

describe('#125: report + CSV artifacts honor the active locale', () => {
  it('every builder takes the caller\'s t() (signature pin — artifacts cannot call useT)', () => {
    const reports = readSrc('src/frontend/mjengo/report-utils.ts')
    expect(reports).toContain('buildDailyReportCSV(t: TranslateFn')
    expect(reports).toContain('buildWeeklyReportCSV(t: TranslateFn')
    expect(reports).toContain('buildFinancialReportCSV(t: TranslateFn')
    expect(reports).toContain('buildProcurementReportCSV(t: TranslateFn')
    expect(reports).toContain('downloadWeeklyReportPDF(t: TranslateFn')
    const exports = readSrc('src/frontend/mjengo/export-utils.ts')
    expect(exports).toContain('materialsLedgerCSV(t: TranslateFn')
    expect(exports).toContain('reconciliationCSV(t: TranslateFn')
    expect(exports).toContain('attendanceCSV(t: TranslateFn')
    expect(exports).toContain('transactionsCSV(t: TranslateFn')
    expect(exports).toContain('invoicesCSV(t: TranslateFn')
    expect(exports).toContain('projectSummaryCSV(t: TranslateFn')
  })

  it('the report/csv families resolve in both dictionaries with honest EN/SW values', () => {
    for (const key of [
      'report.h.project', 'report.h.client', 'report.h.location', 'report.h.generated',
      'report.daily.title', 'report.weekly.title', 'report.financial.title', 'report.procurement.title',
      'report.pdf.footer', 'csv.mat.material', 'csv.rec.variance', 'csv.att.worker',
      'csv.tx.date', 'csv.sum.project',
    ]) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
    // EN keeps the audited wording; SW renders the Kiswahili twin.
    expect(translate(enDict, 'report.h.project', { name: 'Riverside Villas' })).toBe('Project: Riverside Villas')
    expect(translate(swDict, 'report.h.project', { name: 'Riverside Villas' })).toBe('Mradi: Riverside Villas')
    expect(translate(enDict, 'csv.rec.variance')).toBe('Variance (Expected − Counted)')
    expect(translate(swDict, 'csv.rec.variance')).toBe('Tofauti (Inayotarajiwa − Iliyopimwa)')
    expect(translate(swDict, 'report.daily.movements')).toContain('SITE STORE') // stored proper noun stays
    expect(translate(swDict, 'report.daily.crewLine', { today: 4, expected: 5, wages: 3000, alerts: 1 }))
      .toBe('Wafanyakazi 4/5 leo · mishahara 3000 KES · tahadhari 1 hazijakubaliwa')
  })
})

// ---------------------------------------------------------------------------
// #140 (audit FE-9): the USSD simulation body is bilingual. The tab shipped
// #107 with chrome-only translation (5 keys); this block pins the completion:
// every literal t() key the tab calls resolves in both dictionaries, the
// lcd/input/keypad/net/explainer/pin/toast/dispatch families exist EN+SW,
// the raw English that used to be hardcoded (BOOT_LINES, menu script,
// toasts, explainer) is gone, and the dial syntax (*384#, menu digit
// prefixes, ITU E.161 keypad letters) stays data — assembled around the
// translated copy, never inside it.
// ---------------------------------------------------------------------------

describe('#140: USSD tab body — every literal t() key resolves in both dictionaries', () => {
  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  it('the tab samples enough keys (wiring guard — the chrome-only regression would fail this)', () => {
    const keys = new Set(literalKeysIn(readSrc('src/frontend/mjengo/ussd-tab.tsx')))
    expect(keys.size, 'ussd-tab sampled too few keys').toBeGreaterThan(70)
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const key of new Set(literalKeysIn(readSrc('src/frontend/mjengo/ussd-tab.tsx')))) {
      expect(enKeys.has(key), `en.ts is missing "${key}" (used by ussd-tab)`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}" (used by ussd-tab)`).toBe(true)
    }
  })

  it('no raw English toast literals on the USSD path', () => {
    const RAW_TOAST = /toast\.(?:success|error|info|warning)\(\s*(?:['"]|`(?!\$\{t\())/g
    const offending = [...readSrc('src/frontend/mjengo/ussd-tab.tsx').matchAll(RAW_TOAST)]
    expect(offending, 'ussd-tab still fires raw-literal toasts').toEqual([])
  })
})

describe('#140: the ussd.* body families exist in both dictionaries', () => {
  const FAMILIES: Record<string, string[]> = {
    lcd: [
      'ussd.lcd.bootReady', 'ussd.lcd.bootDial', 'ussd.lcd.dialing', 'ussd.lcd.welcome',
      'ussd.lcd.muster', 'ussd.lcd.mark', 'ussd.lcd.exit', 'ussd.lcd.invalid',
      'ussd.lcd.callEnded', 'ussd.lcd.name', 'ussd.lcd.role', 'ussd.lcd.alreadyToday',
      'ussd.lcd.pinPrompt', 'ussd.lcd.tooMany', 'ussd.lcd.endedKwaheri', 'ussd.lcd.pinBadA',
      'ussd.lcd.pinBadB', 'ussd.lcd.readonlyA', 'ussd.lcd.readonlyB', 'ussd.lcd.readonlyC',
      'ussd.lcd.recording', 'ussd.lcd.recorded', 'ussd.lcd.asante', 'ussd.lcd.queuedA',
      'ussd.lcd.queuedB', 'ussd.lcd.sessionEnded', 'ussd.lcd.failA', 'ussd.lcd.failB',
      'ussd.lcd.bye', 'ussd.lcd.confirm', 'ussd.lcd.yes', 'ussd.lcd.no', 'ussd.lcd.cancelled',
      'ussd.lcd.screenAria',
    ],
    input: [
      'ussd.input.aria', 'ussd.input.calling', 'ussd.input.pin', 'ussd.input.reply',
      'ussd.input.sending', 'ussd.input.ended', 'ussd.input.dialAgain',
    ],
    keypad: [
      'ussd.keypad.key', 'ussd.keypad.keyWithSub', 'ussd.keypad.delete', 'ussd.keypad.call',
      'ussd.keypad.callAria', 'ussd.keypad.callNew', 'ussd.keypad.end',
    ],
    net: [
      'ussd.net.srOnline', 'ussd.net.srOffline', 'ussd.net.onlineNote',
      'ussd.net.offlineNote', 'ussd.net.offlinePending',
    ],
    explainer: [
      'ussd.explainer.title', 'ussd.explainer.anyPhone', 'ussd.explainer.anyPhoneRest',
      'ussd.explainer.pin', 'ussd.explainer.muster', 'ussd.explainer.offline',
    ],
    pin: [
      'ussd.pin.title', 'ussd.pin.empty', 'ussd.pin.kiosk', 'ussd.pin.phone',
      'ussd.pin.more', 'ussd.pin.note',
    ],
    honesty: ['ussd.honesty'],
    toast: ['ussd.toast.checkedIn', 'ussd.toast.absent', 'ussd.toast.queued'],
    dispatch: ['ussd.dispatch.checkIn', 'ussd.dispatch.absent'],
  }

  it('every family key resolves in both dictionaries', () => {
    for (const keys of Object.values(FAMILIES)) {
      for (const key of keys) {
        expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
      }
    }
  })

  it('spot Kiswahili values render through the real translate()', () => {
    expect(translate(enDict, 'ussd.lcd.bootReady')).toBe('MjengoOS sim ready.')
    expect(translate(swDict, 'ussd.lcd.bootReady')).toBe('Uigaji wa MjengoOS uko tayari.')
    expect(translate(swDict, 'ussd.lcd.bootDial')).toBe('Bonyeza *384# kisha Piga.')
    expect(translate(swDict, 'ussd.lcd.mark')).toBe('Rekodi mahudhurio')
    expect(translate(swDict, 'ussd.lcd.name', { name: 'Otieno' })).toBe('Jina: Otieno')
    expect(translate(swDict, 'ussd.lcd.alreadyToday', { status: 'Yupo' })).toBe('Tayari leo: Yupo')
    expect(translate(swDict, 'ussd.lcd.pinBadB', { n: 2 })).toBe('jaribu tena. (majaribio 2 yamebaki)')
    expect(translate(swDict, 'ussd.lcd.confirm', { status: 'YUPO' })).toBe('Rekodi kama YUPO?')
    expect(translate(swDict, 'ussd.keypad.end')).toBe('Kata simu')
    expect(translate(swDict, 'ussd.keypad.keyWithSub', { main: '2', sub: 'ABC' })).toBe('Kitufe 2, ABC')
    expect(translate(swDict, 'ussd.explainer.title')).toBe('Mstari halisi unafanyaje kazi')
    expect(translate(swDict, 'ussd.pin.note')).toContain('PIN ya kioski')
    expect(translate(swDict, 'ussd.net.offlinePending', { n: 3 }))
      .toBe('Mtandao wa sim hauko mtandaoni (umezimwa kwenye hifadhi) — rekodi zinasubiri kwenye kifaa (3 zinazosubiri).')
    expect(translate(swDict, 'ussd.toast.checkedIn', { name: 'Otieno' })).toBe('*384# — Otieno ameingia kazi')
  })

  it('the LCD reuses the fundis status labels (worker menu + already-today line)', () => {
    for (const s of ['present', 'half_day', 'absent', 'excused']) {
      expect(enKeys.has(`fundis.status.${s}`), `en.ts is missing fundis.status.${s}`).toBe(true)
      expect(swKeys.has(`fundis.status.${s}`), `sw.ts is missing fundis.status.${s}`).toBe(true)
    }
    expect(readSrc('src/frontend/mjengo/ussd-tab.tsx')).toContain('`fundis.status.${')
  })

  it('dial syntax stays data: *384#, menu digits and the stored recordedBy never live in the dicts', () => {
    const src = readSrc('src/frontend/mjengo/ussd-tab.tsx')
    // menu digit prefixes are assembled around the translated option
    expect(src).toContain("`1. ${t('ussd.lcd.mark')}`")
    expect(src).toContain("`2. ${t('ussd.lcd.exit')}`")
    expect(src).toContain("`1. ${t('ussd.lcd.yes')}`")
    // the raw English that shipped pre-#140 is gone
    expect(src).not.toContain('BOOT_LINES')
    expect(src).not.toContain("'Welcome to MjengoOS'")
    expect(src).not.toContain("'1. Mark attendance'")
    expect(src).not.toContain("'How the real line works'")
    expect(src).not.toContain('Demo PINs')
    // the attendance record's stored recordedBy stays locale-independent data
    expect(src).toContain("recordedBy: 'USSD *384#'")
    // the real dispatch behavior is untouched (the #140 hard line)
    expect(src).toContain("'attendance.checkin'")
    expect(src).toContain("'attendance.record'")
  })
})

// ---------------------------------------------------------------------------
// #152 uikit fallbacks (audit spot-check): the shared kit's own fallback
// copy — the ErrorBoundary crash card and the DataTable empty/aria defaults
// — flows through the dicts in both languages, and the uikit stays free of
// raw English. Also pins the outside-provider design: the crash card reads
// the persisted locale store directly, never the I18nProvider context.
// ---------------------------------------------------------------------------

describe('#152: uikit fallbacks — crash card + empty state resolve the dicts', () => {
  const UIKIT_FILES = [
    'src/frontend/mjengo/uikit/error-boundary.tsx',
    'src/frontend/mjengo/uikit/data-table.tsx',
    'src/frontend/mjengo/uikit/empty-state.tsx',
  ] as const

  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  it('every literal t() key the uikit calls exists in both dictionaries', () => {
    // Catches the #125 regression class: data-table called t('uikit.noRows')
    // for two waves while NO dictionary carried the key — the empty state
    // rendered the literal string "uikit.noRows".
    const keys = new Set(UIKIT_FILES.flatMap((f) => literalKeysIn(readSrc(f))))
    expect(keys.size, 'the uikit sample found no t() keys (regex drift?)').toBeGreaterThan(2)
    for (const key of keys) {
      expect(enKeys.has(key), `en.ts is missing "${key}" (used by the uikit)`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}" (used by the uikit)`).toBe(true)
    }
  })

  it('the uikit fallback families exist in both dictionaries', () => {
    for (const key of [
      'uikit.errorTitle', 'uikit.errorMessage', 'uikit.retry', 'uikit.reloadApp',
      'uikit.reassurance', 'uikit.noRows', 'uikit.tableRegion',
    ]) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })

  it('the crash card renders the right copy in both locales (real translateForLocale)', () => {
    expect(translateForLocale('en', 'uikit.errorTitle')).toBe('Something went wrong')
    expect(translateForLocale('sw', 'uikit.errorTitle')).toBe('Kuna kitu kimeharibika')
    expect(translateForLocale('en', 'uikit.errorMessage'))
      .toBe('An unexpected error occurred while rendering this section.')
    expect(translateForLocale('sw', 'uikit.errorMessage'))
      .toBe('Hitilafu isiyotarajiwa ilitokea wakati wa kuonyesha sehemu hii.')
    expect(translateForLocale('sw', 'uikit.retry')).toBe('Jaribu tena')
    expect(translateForLocale('sw', 'uikit.reloadApp')).toBe('Pakia programu upya')
    expect(translateForLocale('sw', 'uikit.reassurance'))
      .toBe('Hakuna kilichopotea — sehemu nyingine za MjengoOS zinaendelea kufanya kazi.')
    expect(translateForLocale('en', 'uikit.noRows')).toBe('No rows to show')
    expect(translateForLocale('sw', 'uikit.noRows')).toBe('Hakuna matokeo ya kuonyesha')
    expect(translateForLocale('en', 'uikit.tableRegion', { columns: 'Fundi, Status' }))
      .toBe('Fundi, Status — scrollable rows')
    expect(translateForLocale('sw', 'uikit.tableRegion', { columns: 'Fundi, Hali' }))
      .toBe('Fundi, Hali — safu unazoweza kusogeza')
  })
})

describe('#152: uikit carries no raw English (the ban scope now includes the shared kit)', () => {
  // Comments are stripped before scanning — the docblocks legitimately quote
  // the old English copy while explaining the fix.
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  // The legacy hardcoded literals, pinned with their render context so the
  // pinned names cannot collide with the new t('uikit.*') calls.
  const LEGACY_RAW_ENGLISH: RegExp[] = [
    /\?\?\s*['"]Something went wrong['"]/,
    /aria-hidden\s*\/>\s*Retry/,
    /aria-hidden\s*\/>\s*Reload app/,
    /Nothing was lost/,
    /An unexpected error occurred while rendering/,
    /title="No rows to show"/,
  ]

  // General guards for the three shapes raw English took in the uikit:
  //  · a quoted multi-word string literal starting with a capital letter
  //    ("Something went wrong", "No rows to show", …);
  //  · words trailing a self-closing tag on the same line (`/> Retry`);
  //  · a line consisting solely of sentence words (the reassurance <p>
  //    body). A three-word minimum plus space/comma/em-dash-only separators
  //    keep real code out: dashed attributes (`aria-hidden`), multi-line
  //    call arguments (`error,`), dotted member expressions
  //    (`return this.props.children`) and two-word statements
  //    (`return WithBoundary`) all fail it, while every sentence the kit
  //    ever hardcoded passes.
  const QUOTED_SENTENCE = /['"`]([A-Z][A-Za-z0-9]*(?:[ ,—'’-][A-Za-z0-9]+)+[.!?…]*)['"`]/
  const TRAILING_JSX_TEXT = /\/>\s*[A-Za-z][A-Za-z ]+$/
  const OWN_LINE_JSX_TEXT = /^\s+(?:[A-Za-z0-9'’]+[ ,—]+){2,}[A-Za-z0-9'’]+[.!?…]*\s*$/m

  it('the legacy hardcoded literals are gone from every uikit file', () => {
    for (const file of [
      'src/frontend/mjengo/uikit/error-boundary.tsx',
      'src/frontend/mjengo/uikit/data-table.tsx',
    ]) {
      const code = stripComments(readSrc(file))
      for (const pattern of LEGACY_RAW_ENGLISH) {
        expect(pattern.test(code), `${file} still matches the legacy literal ${pattern}`).toBe(false)
      }
    }
  })

  it('no new raw English sentence literals or bare JSX text in the uikit', () => {
    for (const file of [
      'src/frontend/mjengo/uikit/error-boundary.tsx',
      'src/frontend/mjengo/uikit/data-table.tsx',
      'src/frontend/mjengo/uikit/empty-state.tsx',
    ]) {
      const code = stripComments(readSrc(file))
      expect(code.match(QUOTED_SENTENCE), `${file} has a raw quoted English sentence`).toBeNull()
      expect(code.match(TRAILING_JSX_TEXT), `${file} has bare JSX text after a self-closing tag`).toBeNull()
      expect(code.match(OWN_LINE_JSX_TEXT), `${file} has an own-line bare JSX text node`).toBeNull()
    }
  })
})

describe('#152: the crash card reads the locale provider-free (design pin)', () => {
  it('ErrorBoundary never touches the i18n context — the store is its source of truth', () => {
    const code = readSrc('src/frontend/mjengo/uikit/error-boundary.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // useT() throws outside <I18nProvider> — a fallback that throws while the
    // provider is down would white-screen the whole app. The store + helper
    // are the SAME source of truth and dicts the provider itself uses.
    expect(code, 'the crash card must not depend on the i18n context').not.toContain('useT')
    expect(code).toContain('useLocalePrefs((s) => s.language)')
    expect(code).toContain('translateForLocale')
    // The title override prop still wins over the localized default (#152 AC).
    expect(readSrc('src/frontend/mjengo/uikit/error-boundary.tsx'))
      .toContain("title ?? t('uikit.errorTitle')")
  })

  it('DataTable is a normal in-tree surface — it keeps the canonical useT() hook', () => {
    // Contrast with the crash card above: the table only ever renders inside
    // the app tree (below the provider), so the reactive context hook is the
    // right tool there — no provider-free machinery needed.
    expect(readSrc('src/frontend/mjengo/uikit/data-table.tsx')).toContain('const t = useT()')
  })
})
