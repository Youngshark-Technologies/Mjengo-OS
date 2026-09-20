/**
 * Store/session fixtures for the tests/dom runtime suites (issue #137).
 *
 * The suites render the REAL MjengoApp/Header against the REAL zustand
 * stores — the only doubles are the next-auth session (vi.mock, per test
 * file) and this minimal seeded payload. The fixture keeps every field the
 * rendered header/app/bottom-nav actually read (project identity, summary,
 * notifications) and omits the rest of ProjectPayload's ~20 slices: every
 * consumer in the tree optional-chains into them (`data?.intel?.flags`,
 * `data?.notifications ?? []`), so a cast fixture stays honest — the cast is
 * the documented seam, exactly like the stubbed-document seam in
 * tests/unit/html-lang.test.ts.
 */
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import type { ProjectListItem, ProjectPayload } from '@/backend/lib/mjengo'

export const QA_PROJECT_ID = 'qa-p1'

const payload = {
  project: {
    id: QA_PROJECT_ID,
    name: 'QA Bungalow',
    client: 'Mama Halima',
    clientType: 'individual',
    location: 'Karen, Nairobi',
    status: 'active',
    startDate: '2026-01-05',
    targetDate: '2026-09-30',
    budgetTotal: 4_500_000,
    budgetSpent: 1_125_000,
    progressPct: 25,
    dayCount: 120,
    shareToken: 'share-qa-token',
  },
  summary: { dayCount: 120, progressPct: 25, budgetSpent: 1_125_000, budgetTotal: 4_500_000 },
  notifications: [],
  // No `flags` key: tabsVisibleForFlags treats undefined as "no intel yet"
  // and returns the role tab set unfiltered — the plain owner strip.
  intel: {},
} as unknown as ProjectPayload

const projectListItem: ProjectListItem = {
  id: QA_PROJECT_ID,
  name: 'QA Bungalow',
  client: 'Mama Halima',
  clientType: 'individual',
  location: 'Karen, Nairobi',
  status: 'active',
  startDate: '2026-01-05',
  targetDate: '2026-09-30',
  budgetTotal: 4_500_000,
  budgetSpent: 1_125_000,
  progressPct: 25,
  dayCount: 120,
  fundisCount: 6,
  unackedAlerts: 0,
  photoCount: 3,
}

/**
 * Reset the persisted owner store to a seeded, online, owner-mode project
 * BEFORE mounting (and again in beforeEach between tests): the app's mount
 * effects check `!data || projects.length === 0` before calling load(), so a
 * seeded store renders the main shell with ZERO fetches.
 */
export function seedOwnerStore(): void {
  useMjengo.setState({
    data: payload,
    projects: [projectListItem],
    activeProjectId: QA_PROJECT_ID,
    viewMode: 'owner',
    shareToken: null,
    clientRole: false,
    shareError: null,
    loading: false,
    online: true,
    syncing: false,
    outbox: [],
    syncHistory: [],
    lastSyncAt: null,
    pendingNetwork: [],
    persistDegraded: false,
    persistQueueOnly: false,
    notificationsSeenAt: null,
    actionBusy: null,
    dataMode: 'normal',
  })
}
