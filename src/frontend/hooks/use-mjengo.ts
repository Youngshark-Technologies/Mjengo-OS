'use client'

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import { toast } from 'sonner'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { translate } from '@/frontend/i18n/provider'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import type { ProjectPayload, ProjectListItem, ActionType, WorkerWithAttendance } from '@/backend/lib/mjengo'
// #207: the ONE low-stock rule — pure module, shared with the backend's
// payload boundary, so the offline optimistic badge can never disagree with
// the server's flag once the queued action syncs.
import { isLowStock } from '@/backend/modules/inventory/low-stock'
// #128: the outbox core (item shape §40/§41, #132 auto-retry engine, migration
// normalizer) is shared with the SUPPLIER portal's outbox store — extracted to
// src/frontend/lib/outbox.ts, parameterized so the two apps never share state.
// Everything below re-exports the shared pieces so this module's public API
// (panels, tests) is byte-for-byte what it always was.
import {
  uid,
  normalizeOutboxItem,
  withAutoRetrySchedule,
  SYNC_HISTORY_CAP,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_DELAYS_MS,
  createAutoRetryEngine,
  type OutboxItem,
  type OutboxSyncStatus,
  type ConflictRule,
  type SyncHistoryItem,
  type SyncItemResult,
} from '@/frontend/lib/outbox'
// #193: Background Sync registration — the feature-detected pure helper
// (sw-handlers.ts, unit-tested) the enqueue seams below ride on.
import { registerOutboxSync } from '@/frontend/sw-handlers'

export type { OutboxItem, OutboxSyncStatus, ConflictRule, SyncHistoryItem, SyncItemResult }
export { normalizeOutboxItem, AUTO_RETRY_MAX_ATTEMPTS, AUTO_RETRY_DELAYS_MS }

/**
 * Toast-time translator (W7 · issue #79 — sync/dispatch toasts). This zustand
 * store lives OUTSIDE React render, so the useT() hook can't be used here;
 * instead the locale is read imperatively from the i18n prefs store at
 * call time (same {var} interpolation as useT — see provider.translate).
 * Toast strings only — another wave owns the dispatch logic itself.
 */
const t = (key: string, vars?: Record<string, string | number>): string =>
  translate(useLocalePrefs.getState().language === 'sw' ? swDict : enDict, key, vars)

/** Body for POST /api/projects (matches CreateProjectPayload from the dialog). */
export interface CreateProjectInput {
  name: string
  budget: number
  client?: string
  clientType?: string
  location?: string
  startDate?: string
  targetDate?: string
  template?: 'bungalow' | 'maisonette' | 'duplex' | 'blank'
}

export type ViewMode = 'owner' | 'client'

/** Connectivity mode (spec §74 low-data): 'normal' | 'data_saver'. */
export type DataMode = 'normal' | 'data_saver'

/** Actions a client may perform (shared with the server guards — single source of truth). */
export { CLIENT_ACTIONS } from '@/shared/client-actions'
import { CLIENT_ACTIONS as CLIENT_ACTION_LIST } from '@/shared/client-actions'

interface MjengoState {
  data: ProjectPayload | null
  projects: ProjectListItem[]
  activeProjectId: string | null
  viewMode: ViewMode
  /** Non-null while the app is acting as a real client via /?share=<token> (not the owner preview). */
  shareToken: string | null
  /** True when a logged-in client-ROLE user is in the client view (no share token — they belong there). */
  clientRole: boolean
  /** Set when a share link fails to resolve (invalid/revoked) — drives the dead-link screen. */
  shareError: string | null
  /** Epoch ms of the last time the user opened the notification center. */
  notificationsSeenAt: number | null
  actionBusy: string | null
  loading: boolean
  online: boolean
  syncing: boolean
  outbox: OutboxItem[]
  /** Synced + conflict-resolved items, retained (capped) as history for inspection. */
  syncHistory: SyncHistoryItem[]
  lastSyncAt: number | null
  /**
   * #192 — persistence health (NEVER persisted; flipped by the guarded
   * storage adapter below). `persistDegraded`: the last write attempt
   * failed outright (quota full / private mode / security software) — the
   * in-memory store keeps working, but nothing since the last good
   * snapshot reaches disk (queued mutations are one tab-close from loss).
   * `persistQueueOnly`: the last successful write was the #192 fallback —
   * the re-fetchable `data` slice was dropped so the mutation queue fits;
   * the queue is banked on-device, offline READS won't survive a restart.
   * The app-level banner (app.tsx) renders while either is set.
   */
  persistDegraded: boolean
  persistQueueOnly: boolean
  /**
   * #150 — the "Waiting for network" worklist: online-only flows the user
   * attempted while offline (money pay/payroll, AI review, copilot, trust
   * digest). REMINDERS, not queued mutations — see the #150 section comment.
   */
  pendingNetwork: PendingNetworkItem[]
  /** Low-data mode (spec §74) — persisted so it survives reloads. */
  dataMode: DataMode
  setDataMode: (m: DataMode) => void
  load: () => Promise<void>
  /** Boot the public client view from a share token (GET /api/share). */
  bootFromShare: (token: string, fromUrl?: boolean) => Promise<void>
  switchProject: (id: string) => Promise<void>
  createProject: (payload: CreateProjectInput) => Promise<boolean>
  setViewMode: (v: ViewMode) => void
  setOnline: (v: boolean) => void

  dispatch: (type: ActionType, payload: any, label: string) => Promise<boolean>

  applyLocal: (type: ActionType, payload: any) => void
  syncNow: () => Promise<{ synced: number; failed: number; conflicts: number } | undefined>
  /** Items the server refused with a conflict — derived from the outbox (spec §41). */
  getConflicts: () => OutboxItem[]
  /** Resolve a conflict: keep the server version, or force-apply the local one (financial rows: the server always wins). */
  resolveConflict: (id: string, choice: 'keep-server' | 'keep-mine') => Promise<boolean>
  /** Re-queue every failed item for ONE manual drain attempt (no auto-retry loops). */
  retryAll: () => void
  /** #150 — record an online-only refusal as a waiting reminder (deduped per intent, capped). */
  enqueuePendingNetwork: (entry: PendingNetworkInput) => void
  /** #150 — drop one waiting reminder (the Discard button / a consumed Retry-now). */
  discardPendingNetwork: (id: string) => void
  /**
   * #191: drain a queue stranded by an auth-blocked (401) drain. Called from
   * app.tsx when a session (re)authenticates: re-queues auth-blocked items and
   * flushes the pending queue once when online. Resolves to whether a drain
   * was started.
   */
  drainAfterAuth: () => Promise<boolean>
}

// Exported for tests (issue #183 — the issue's sanctioned seam): the outbox
// conflict chain's PURE halves (stampBaseVersion / reduceLocal /
// bumpLocalAttendanceVersion) are unit-pinned directly. No other module
// imports them; the export exists so the client-side version-stamping chain
// is tested without going through fetch stubs. (normalizeOutboxItem is
// re-exported above from the shared lib/outbox core — #128.)
export {
  stampBaseVersion,
  reduceLocal,
  bumpLocalAttendanceVersion,
}

// ---------------- #132 — bounded auto-retry for failed outbox items ----------------
//
// The engine itself lives in src/frontend/lib/outbox.ts (createAutoRetryEngine,
// #128 — shared with the supplier outbox store). The wrappers below keep this
// module's internal call-sites and the names the tests pin; the HOST adapters
// bind the shared cadence to THIS store's state without sharing any of it.

const autoRetry = createAutoRetryEngine({
  getState: () => useMjengo.getState(),
  requeue: (ids) =>
    useMjengo.setState({
      outbox: useMjengo.getState().outbox.map((o) =>
        ids.has(o.id)
          ? { ...o, syncStatus: 'pending' as const, nextAttemptAt: undefined }
          : o),
    }),
  syncNow: () => useMjengo.getState().syncNow(),
})

function clearAutoRetryTimer(): void {
  autoRetry.clear()
}

/** #132 — re-queue hard-failed items whose backoff has elapsed (delegates to the shared engine). */
function requeueDueFailedItems(): number {
  return autoRetry.requeueDue()
}

function armAutoRetryTimer(): void {
  autoRetry.arm()
}

// ---------------- #193 — Background Sync registration at enqueue time ----------------
//
// Queuing an outbox item ALSO asks the browser to drain it when connectivity
// returns, even if the app is closed by then (Chromium's Background Sync;
// Safari/Firefox keep today's page-lifetime behavior — the helper
// feature-detects). Best-effort BY CONSTRUCTION: fire-and-forget, every
// failure mode swallowed — a refused or unsupported registration must never
// break the enqueue it rides on. The sw.js `sync` handler posts
// { type: 'mjengoos:drain' } at any open client (app.tsx listens and runs
// syncNow); a closed app defers honestly to the next app open (documented
// limit — the SW cannot read the page's localStorage outbox).
function registerOutboxBackgroundSync(): void {
  try {
    if (typeof navigator === 'undefined') return // SSR / node tests
    const sw = navigator.serviceWorker
    if (!sw || typeof sw.getRegistration !== 'function') return
    void sw
      .getRegistration()
      .then((registration) => registerOutboxSync(registration))
      .catch(() => undefined) // a rejected lookup must never ripple out
  } catch {
    // Synchronous surprises (frozen/absent globals) are equally not ours to fail on.
  }
}

// ---------------- #150 — the "Waiting for network" worklist ----------------
//
// Online-only flows (money payment.pay, fundis wages.pay, AI draw review,
// copilot analyze/voice/scan/docs, trust digest) refuse honestly with a
// toast when offline — but the refusal had no MEMORY: the user had to
// remember to come back and redo the action. This slice is that memory:
// every guard that refuses also records a reminder entry, surfaced in a
// header panel (pending-network-panel.tsx) with Retry-now (navigates back
// to the flow) and Discard, and re-surfaced by the reconnect toast
// ("{count} action(s) are waiting for a connection" — mirrors the outbox's
// sync.backOnlineDraining pattern).
//
// REMIND-ONLY, BY DELIBERATE DECISION (the issue's per-flow choice):
//   · NO entry is ever auto-executed. Money flows keep their hard stop —
//     auto-paying a payroll or payment request from a reminder list, hours
//     after the attempt, is a large idempotency surface (the user may have
//     settled it another way in the meantime; the online path's idempotency
//     discipline was never designed for deferred execution), and the issue
//     explicitly sanctions "keep the hard-stop with a 'remind me' entry
//     only". AI/copilot flows cannot queue anyway — their inputs (photo
//     dataURLs, voice blobs, typed text) are ephemeral and the guards
//     refuse before anything is uploaded.
//   · Retry-now NAVIGATES (the 'mjengo:tab' event — app.tsx's role-filtered
//     listener) and consumes the reminder; completing the action stays
//     human. Nothing on this list is ever posted to /api/sync.
//   · PERSISTED deliberately (see the partialize decision comment): a
//     reload is exactly the "user must remember" failure mode this slice
//     exists to fix — losing the list on refresh would defeat the point,
//     and entries are tiny (kind + dict key + timestamp + short context
//     vars) behind a cap. This is NOT the outbox: outbox items are drained
//     mutations with a §40 lifecycle; pendingNetwork items are intent
//     reminders with a human-only lifecycle (retry-navigate / discard).

/** The tabs the guarded flows live on (Retry-now targets; app.tsx's mjengo:tab listener re-checks role visibility). */
export type PendingNetworkTab = 'money' | 'fundis' | 'copilot' | 'intel'

/** Which online-only flow was refused (drives dedupe: kind + context = one intent). */
export type PendingNetworkKind =
  | 'payment.pay'
  | 'ai.drawReview'
  | 'wages.pay'
  | 'copilot.analyze'
  | 'copilot.voice'
  | 'copilot.voiceParse'
  | 'copilot.scan'
  | 'copilot.docs'
  | 'copilot.docsReview'
  | 'ai.trustDigest'
  | 'ai.trustAudio'

/**
 * One online-only refusal the user attempted offline (#150). A REMINDER,
 * not a queued mutation — the label renders from the dict at DISPLAY time
 * (locale follows the UI, not the enqueue moment), so the stored shape is
 * key + interpolation vars, never a frozen sentence.
 */
export interface PendingNetworkItem {
  id: string
  kind: PendingNetworkKind
  /** Dict key for the human label (rendered via t(labelKey, context)). */
  labelKey: string
  /** Label interpolation vars (payment code, payroll period, file name…). */
  context?: Record<string, string | number>
  /** Epoch ms of the LATEST offline attempt (a repeat refreshes, not stacks). */
  createdAt: number
  /** The tab Retry-now focuses ('mjengo:tab'). */
  tab: PendingNetworkTab
}

/** The enqueue seam's shape — id/createdAt are the store's to stamp. */
export type PendingNetworkInput = Omit<PendingNetworkItem, 'id' | 'createdAt'>

/**
 * Newest-kept cap for the worklist. A reminder list that outgrows this is a
 * forgotten to-do list anyway; entries are per-INTENT (deduped), so the cap
 * only bites after ~20 genuinely different refused flows.
 */
export const PENDING_NETWORK_CAP = 20

// ---------------- #192 — guarded persistence (quota / private mode) ----------------
//
// The whole app state (ProjectPayload `data` + the outbox + syncHistory)
// lives in ONE localStorage key. Before #192 a failed setItem
// (QuotaExceededError on a full low-storage Android, iOS private-window
// PWA, security software) propagated straight out of `set()`: zustand's
// persist middleware calls storage.setItem synchronously inside every
// setState, so the exception broke whichever action was running, the
// in-memory store kept accepting optimistic writes, and every queued
// field mutation sat silently one tab-close from loss — no surface ever
// said so (the SW has a quota LRU for photos; the mutation queue had
// nothing).
//
// The fix is a storage ADAPTER (the zustand createJSONStorage seam), not
// a change to WHAT is persisted (see the partialize decision comment):
//   · every write failure is CAUGHT — the triggering action never sees
//     the exception; the in-memory store remains the source of truth;
//   · a quota failure retries ONCE with the re-fetchable `data` slice
//     dropped (queue-only fallback): the mutation queue is the only part
//     of the payload that is NOT re-fetchable from the server, so a full
//     device still banks the user's work;
//   · the outcome flips the non-persisted persistDegraded/persistQueueOnly
//     flags → the app.tsx banner — degradation is LOUD, never silent;
//   · a later successful FULL write self-heals the flags.

/** The ONE localStorage key the whole owner store persists to (spec §40). */
export const MJENGO_STORE_KEY = 'mjengo-os-store'

/**
 * The raw localStorage seam wrapped for createJSONStorage. Never touches
 * localStorage at module scope — the typeof guard in the persist options
 * below keeps node/SSR exactly as inert as the old default storage.
 */
const guardedLocalStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value)
      setPersistHealth('ok')
      return
    } catch (e) {
      // QuotaExceededError / private-mode refusal. NEVER rethrow: this
      // runs synchronously inside every setState, so an escaping exception
      // would break the action that called set() — the exact silent-loss
      // failure mode #192 exists to fix.
      console.error(`[${MJENGO_STORE_KEY}] persistence write failed — surfacing degradation`, e)
    }
    // Queue-only fallback (the #192 bounding decision): drop `data` (the
    // largest RE-FETCHABLE slice — a reload refills it from /api/project
    // once connectivity returns) and retry once, so the irreplaceable part
    // (the queued mutations + their §41 conflict state) still reaches disk.
    try {
      const parsed = JSON.parse(value) as { state?: Record<string, unknown> }
      if (parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object') {
        localStorage.setItem(name, JSON.stringify({ ...parsed, state: { ...parsed.state, data: null } }))
        setPersistHealth('queue-only')
      } else {
        // Not the shape we know how to slim (should never happen — the
        // value is always createJSONStorage's { state, version }).
        setPersistHealth('degraded')
      }
    } catch {
      // Even the slimmed write does not fit (hard quota / private mode):
      // nothing reaches disk — the loud banner is the only honest signal.
      setPersistHealth('degraded')
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // A failing removal never loses data the app still holds in memory.
    }
  },
}

/**
 * The adapter's write outcome → the store's non-persisted health flags.
 *
 * Re-entrancy: flipping the flags is itself a setState, which itself
 * triggers a storage write (persist writes on EVERY setState) — the depth
 * guard makes that inner write's health report a no-op instead of a loop;
 * the transition check keeps the steady state (every successful write
 * reports 'ok') write-free.
 *
 * TDZ: the FIRST hydrate at store creation can run setItem while the
 * `useMjengo` binding is still initialising (the same reason the
 * onRehydrateStorage timer defers — see below); the report is re-sent a
 * tick later instead of dropped.
 */
let persistHealthDepth = 0
function setPersistHealth(health: 'ok' | 'queue-only' | 'degraded'): void {
  if (persistHealthDepth > 0) return // our own flag-flip's write — already decided
  let s: Pick<MjengoState, 'persistDegraded' | 'persistQueueOnly'>
  try {
    s = useMjengo.getState()
  } catch {
    setTimeout(() => setPersistHealth(health), 0)
    return
  }
  const degraded = health === 'degraded'
  const queueOnly = health === 'queue-only'
  if (s.persistDegraded === degraded && s.persistQueueOnly === queueOnly) return
  persistHealthDepth++
  try {
    useMjengo.setState({ persistDegraded: degraded, persistQueueOnly: queueOnly })
  } finally {
    persistHealthDepth--
  }
}

/**
 * FE-6a (issue #80) — load sequencing token. Every load(), switchProject() and
 * createProject() bumps this counter; a response whose captured token no
 * longer matches was superseded and is DISCARDED before any set(). Without
 * it, a rapid P1→P2→P1 switch races: the LATE stale fetch resolves after the
 * newer one and overwrites `data` + `activeProjectId`, showing the wrong
 * project. Module-level on purpose — it is in-flight-request bookkeeping,
 * never store state, so it is neither persisted nor observable.
 */
let loadSeq = 0

/**
 * FE-6b (issue #80) — one honest toast for a refused /api/actions|share call.
 * The server's { error } text reaches the user verbatim (money-tab's aiReview
 * pattern); a refusal without a reason falls back to the generic copy.
 */
function serverRefusalToast(json: unknown): string {
  const reason =
    json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
      ? (json as { error: string }).error.trim()
      : ''
  return reason ? t('sync.serverRefused', { reason }) : t('sync.applyFailed')
}

/** EAT "today" — mirrors the server's todayStr() so client-side row lookups line up. */
export function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Task mutations whose server appliers version the Task row (mirror of the sync route's set). */
const VERSIONED_TASK_TYPES = [
  'task.update', 'task.assign', 'task.block', 'task.unblock', 'task.complete', 'task.verify',
] as const

/** The worker's local attendance row for a date (default today) — version if known. */
function localAttendanceVersion(data: ProjectPayload, workerId: unknown, date?: string): number | null {
  if (typeof workerId !== 'string' || !workerId) return null
  const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayEAT()
  const w = data.workers.find((x) => x.id === workerId)
  const row = w?.attendances.find((a) => a.date === day) as { version?: number } | undefined
  return row && typeof row.version === 'number' ? row.version : null
}

/**
 * Optimistic attendance version bump (mirrors the server appliers): bump the
 * worker's local day-row when one exists, so a second queued day-action for
 * the same worker stamps the newer baseVersion.
 */
function bumpLocalAttendanceVersion(w: WorkerWithAttendance): void {
  const row = w.attendances.find((a) => a.date === todayEAT()) as { version?: number } | undefined
  if (row) {
    const known = row.version
    row.version = (typeof known === 'number' ? known : 1) + 1
  }
}

/**
 * Stamp the client's known entity version (issue "Outbox conflict metadata +
 * entity versions") onto a queued offline action's payload: task.* by row id,
 * attendance.* by the worker's day-row — EXCEPT attendance.override, which is
 * keyed by the attendance ROW ID (mirroring the server's detectStaleVersion
 * row-id path) — and the bulk muster roll per record. The server REJECTS a
 * flush as 'stale-version' when the row moved on while the device was offline
 * — never a silent last-write-wins overwrite. An absent stamp (row unknown /
 * pre-version local data) applies exactly as today.
 *
 * #183 audit: every type in the server's versioned set
 * (VERSIONED_TASK_TYPES × 6 + VERSIONED_ATTENDANCE_TYPES × 5) is stamped
 * here. attendance.override was the one gap — an offline override queued
 * without baseVersion sailed past detectStaleVersion (null) and applied
 * silently, i.e. last-write-wins for exactly that action type.
 */
function stampBaseVersion(data: ProjectPayload, type: string, payload: any): any {
  if (!payload || typeof payload !== 'object') return payload
  if ((VERSIONED_TASK_TYPES as readonly string[]).includes(type) && payload.id) {
    const task = data.phases.flatMap((p) => p.tasks).find((t) => t.id === payload.id) as { version?: number } | undefined
    if (task && typeof task.version === 'number') return { ...payload, baseVersion: task.version }
    return payload
  }
  if (type === 'attendance.override' && payload.id) {
    // Row-id path (#183): the server versions attendance.override against the
    // row it targets — stamp the client's known version for THAT row so an
    // offline override is rejected when the row moved on.
    const row = data.workers
      .flatMap((w) => w.attendances)
      .find((a) => a.id === payload.id) as { version?: number } | undefined
    if (row && typeof row.version === 'number') return { ...payload, baseVersion: row.version }
    return payload
  }
  if (type === 'attendance.record') {
    // Bulk muster roll: per-record baseVersion for the worker's today-row.
    // The server accepts records as a JSON string OR an array (trust.ts /
    // detectStaleVersion both parse either shape) — stamp whichever arrives
    // and preserve the payload's original shape on the wire.
    let records = payload.records
    if (typeof records === 'string') {
      try {
        records = JSON.parse(records)
      } catch {
        // malformed records — the server answers the honest parse error; send as-is
      }
    }
    if (Array.isArray(records)) {
      const stamped = records.map((r: any) => {
        const v = localAttendanceVersion(data, r?.workerId)
        return typeof v === 'number' ? { ...r, baseVersion: v } : r
      })
      return typeof payload.records === 'string'
        ? { ...payload, records: JSON.stringify(stamped) }
        : { ...payload, records: stamped }
    }
    return payload
  }
  if (type === 'attendance.checkin' || type === 'attendance.setStatus' || type === 'attendance.exception') {
    const v = localAttendanceVersion(data, payload.workerId, payload.date)
    return typeof v === 'number' ? { ...payload, baseVersion: v } : payload
  }
  return payload
}

/** Client-side optimistic reducer — mirrors the on-device SQLite write for queued actions. */
function reduceLocal(data: ProjectPayload, type: string,
  payload: any): ProjectPayload {
  const d: ProjectPayload = JSON.parse(JSON.stringify(data))
  switch (type) {
    case 'task.update': {
      for (const p of d.phases) {
        const t = p.tasks.find((x) => x.id === payload.id)
        if (t) {
          if (typeof payload.progress === 'number') {
            t.progress = Math.max(0, Math.min(100, payload.progress))
            if (t.progress === 100) t.status = 'done'
            else if (t.progress > 0 && t.status === 'pending') t.status = 'in_progress'
          }
          if (payload.status) t.status = payload.status
          // Optimistic entity-version bump (mirrors the server applier): a
          // SECOND offline edit of the same task must stamp the newer
          // baseVersion, or the device would reject its own queued sequence.
          const known = (t as { version?: number }).version
          t.version = (typeof known === 'number' ? known : 1) + 1
        }
      }
      break
    }
    case 'task.create': {
      const p = d.phases.find((x) => x.id === payload.phaseId)
      p?.tasks.push({ id: uid(), phaseId: payload.phaseId, title: payload.title, status: 'pending', progress: 0, dueDate: null, createdAt: new Date(), updatedAt: new Date() } as never)
      break
    }
    case 'task.delete': {
      for (const p of d.phases) {
        const i = p.tasks.findIndex((x) => x.id === payload.id)
        if (i >= 0) { p.tasks.splice(i, 1); break }
      }
      break
    }
    case 'phase.update': {
      const p = d.phases.find((x) => x.id === payload.id)
      if (p) {
        if (typeof payload.progressManual === 'number') { p.progressManual = payload.progressManual; p.progress = payload.progressManual }
        if (payload.status) p.status = payload.status
      }
      break
    }
    case 'phase.create': {
      d.phases.push({
        id: uid(), projectId: d.project.id, name: String(payload.name), order: d.phases.length + 1,
        budget: Number(payload.budget) || 0, status: 'pending', progressManual: null,
        tasks: [], progress: 0, createdAt: new Date(), updatedAt: new Date(),
      } as never)
      d.summary.budgetTotal = d.phases.reduce((s, p) => s + p.budget, 0)
      d.summary.budgetSpentPct = d.summary.budgetTotal
        ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
        : 0
      break
    }
    case 'delivery.create': {
      const m = d.materials.find((x) => x.id === payload.materialId)
      if (m) {
        const cost = typeof payload.unitCost === 'number' && payload.unitCost > 0 ? payload.unitCost : m.unitPrice
        const total = payload.quantity * cost
        m.deliveredQty += payload.quantity
        m.deliveredCost += total
        m.onSiteQty += payload.quantity
        m.stockValue = m.onSiteQty * m.unitPrice
        // #207: mirror the server rule (MaterialRow.lowStock) so the badge
        // tracks the optimistic quantities until the sync refresh lands.
        m.lowStock = isLowStock({ closingQty: m.onSiteQty, inflowQty: m.deliveredQty })
        d.deliveries.unshift({
          id: uid(), projectId: d.project.id, materialId: m.id, material: undefined as never,
          quantity: payload.quantity, unitCost: cost, totalCost: total,
          supplier: payload.supplier || 'Unknown supplier', date: new Date(),
          source: payload.source || 'manual', rawTranscript: payload.rawTranscript ?? null, createdAt: new Date(),
        } as never)
        d.summary.budgetSpent += total
        d.summary.materialSpend += total
        d.summary.budgetSpentPct = Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
      }
      break
    }
    case 'consumption.create': {
      const m = d.materials.find((x) => x.id === payload.materialId)
      if (m) {
        m.consumedQty += payload.quantity
        m.onSiteQty = Math.max(0, m.onSiteQty - payload.quantity)
        m.stockValue = m.onSiteQty * m.unitPrice
        // #207: mirror the server rule (MaterialRow.lowStock) — a queued
        // consumption that drains the pile shows the badge immediately.
        m.lowStock = isLowStock({ closingQty: m.onSiteQty, inflowQty: m.deliveredQty })
        d.consumptions.unshift({
          id: uid(), projectId: d.project.id, materialId: m.id, material: undefined as never,
          quantity: payload.quantity, materialName: m.name, unit: m.unit,
          phaseName: payload.phaseName ?? null, date: new Date(), note: payload.note ?? null, createdAt: new Date(),
        } as never)
      }
      break
    }
    case 'attendance.checkin': {
      const w = d.workers.find((x) => x.id === payload.workerId)
      if (w) {
        bumpLocalAttendanceVersion(w)
        if (!w.todayStatus.status) {
          w.todayStatus = { status: 'present', checkIn: new Date().toISOString(), checkOut: null, method: payload.method || 'geofence', wage: w.dailyRate, paid: false, verification: 'verified', exceptionReason: null }
          d.summary.fundisToday += 1
          d.summary.wagesToday += w.dailyRate
        } else if (payload.toggle === 'out') {
          w.todayStatus = { ...w.todayStatus, checkOut: new Date().toISOString() }
        }
      }
      break
    }
    case 'attendance.setStatus': {
      const w = d.workers.find((x) => x.id === payload.workerId)
      if (w) {
        bumpLocalAttendanceVersion(w)
        const prevWage = w.todayStatus.wage
        const wage = payload.status === 'present' ? w.dailyRate : payload.status === 'half_day' ? w.dailyRate / 2 : 0
        if (!w.todayStatus.status) d.summary.fundisToday += payload.status === 'absent' ? 0 : 1
        w.todayStatus = { ...w.todayStatus, status: payload.status, wage, paid: false }
        d.summary.wagesToday += wage - prevWage
      }
      break
    }
    case 'attendance.record': {
      // Bulk muster roll (#183 adjacent gap): mirror the trust applier — a
      // record whose status already matches the local today-row is a NO-OP
      // (evidence protection: the server leaves the row untouched, no bump),
      // a different status corrects the row (status, wage, manager-reported)
      // and bumps the version.
      let records = payload.records
      if (typeof records === 'string') {
        try { records = JSON.parse(records) } catch { records = null }
      }
      if (Array.isArray(records)) {
        for (const r of records) {
          const w = d.workers.find((x) => x.id === r?.workerId)
          if (!w) continue
          const status = typeof r?.status === 'string' ? r.status : 'present'
          if (w.todayStatus.status === status) continue
          bumpLocalAttendanceVersion(w)
          const prevWage = w.todayStatus.wage
          const wage = status === 'present' ? w.dailyRate : status === 'half_day' ? w.dailyRate / 2 : 0
          if (!w.todayStatus.status) {
            d.summary.fundisToday += status === 'absent' ? 0 : 1
            w.todayStatus = {
              ...w.todayStatus,
              checkIn: status === 'absent' || status === 'excused' ? null : new Date().toISOString(),
            }
          }
          w.todayStatus = { ...w.todayStatus, status, wage, paid: false, method: 'manager', verification: 'reported' }
          // Keep the local day-row itself in step (the Fundis week strip
          // renders from w.attendances, not just todayStatus).
          const row = w.attendances.find((a) => a.date === todayEAT()) as
            | { status?: string; wage?: number; verification?: string }
            | undefined
          if (row) {
            row.status = status
            row.wage = wage
            row.verification = 'reported'
          }
          d.summary.wagesToday += wage - prevWage
        }
      }
      break
    }
    case 'attendance.exception': {
      // Exception (#183 adjacent gap): the trust applier marks the day-row
      // verification 'exception' (+ reason) — creating it as present at full
      // wage when the worker has no row yet.
      const w = d.workers.find((x) => x.id === payload.workerId)
      if (w) {
        bumpLocalAttendanceVersion(w)
        if (!w.todayStatus.status) {
          d.summary.fundisToday += 1
          const prevWage = w.todayStatus.wage
          w.todayStatus = { ...w.todayStatus, status: 'present', checkIn: new Date().toISOString(), wage: w.dailyRate, method: 'manager' }
          d.summary.wagesToday += w.dailyRate - prevWage
        }
        const reason = typeof payload.reason === 'string' ? payload.reason : null
        w.todayStatus = {
          ...w.todayStatus,
          verification: 'exception',
          exceptionReason: reason,
        }
        // The local day-row carries the exception badge too (week strip).
        const row = w.attendances.find((a) => a.date === todayEAT()) as
          | { verification?: string; exceptionReason?: string | null }
          | undefined
        if (row) {
          row.verification = 'exception'
          row.exceptionReason = reason
        }
      }
      break
    }
    case 'attendance.override': {
      // Override (#183): row-id keyed — mirror the trust applier's status
      // change onto the local row, and onto todayStatus when the row is the
      // worker's today-row, so an offline override shows optimistically in
      // the Fundis tab instead of only as a queued toast.
      const w = d.workers.find((x) => x.attendances.some((a) => a.id === payload.id))
      if (w) {
        const row = w.attendances.find((a) => a.id === payload.id) as
          | { version?: number; date?: string; status?: string; wage?: number }
          | undefined
        if (row) {
          const known = row.version
          row.version = (typeof known === 'number' ? known : 1) + 1
          const wage = payload.to === 'present' ? w.dailyRate : payload.to === 'half_day' ? w.dailyRate / 2 : 0
          row.status = payload.to
          row.wage = wage
          if (row.date === todayEAT()) {
            const prevWage = w.todayStatus.wage
            w.todayStatus = {
              ...w.todayStatus,
              status: payload.to,
              wage,
              paid: false,
              // A manager override of an exception row is reported evidence —
              // except excused, which sanctions the absence (applier rule).
              ...(w.todayStatus.verification === 'exception' && payload.to !== 'excused'
                ? { verification: 'reported' }
                : {}),
            }
            d.summary.wagesToday += wage - prevWage
          }
        }
      }
      break
    }
    case 'worker.create': {
      d.workers.push({
        id: uid(), projectId: d.project.id, name: payload.name, role: payload.role || 'Mtumishi (Labourer)',
        phone: payload.phone || '', dailyRate: Number(payload.dailyRate) || 800, active: true,
        attendances: [], todayStatus: { status: null, checkIn: null, checkOut: null, method: null, wage: 0, paid: false }, weekEarnings: 0,
      } as never)
      d.summary.fundisExpected += 1
      break
    }
    case 'worker.update': {
      const w = d.workers.find((x) => x.id === payload.id)
      if (w) {
        if (typeof payload.name === 'string' && payload.name.trim()) w.name = payload.name.trim()
        if (typeof payload.role === 'string' && payload.role.trim()) w.role = payload.role
        if (typeof payload.phone === 'string') w.phone = payload.phone
        if (typeof payload.dailyRate === 'number' && payload.dailyRate >= 0) w.dailyRate = payload.dailyRate
        if (typeof payload.active === 'boolean') {
          const wasActive = w.active
          w.active = payload.active
          if (wasActive && !payload.active) d.summary.fundisExpected = Math.max(0, d.summary.fundisExpected - 1)
          else if (!wasActive && payload.active) d.summary.fundisExpected += 1
        }
      }
      break
    }
    case 'expense.create': {
      const amount = Number(payload.amount) || 0
      d.transactions.unshift({
        id: uid(), projectId: d.project.id, type: payload.type, amount,
        method: payload.method || 'mpesa', reference: payload.reference ?? null, note: payload.note ?? null,
        date: payload.date ? new Date(payload.date) : new Date(), createdAt: new Date(),
      } as never)
      d.summary.budgetSpent += amount
      if (payload.type === 'material') d.summary.materialSpend += amount
      d.summary.budgetSpentPct = d.summary.budgetTotal
        ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
        : 0
      break
    }
    case 'transaction.delete': {
      const i = d.transactions.findIndex((t) => t.id === payload.id)
      if (i >= 0) {
        const [tx] = d.transactions.splice(i, 1)
        d.summary.budgetSpent = Math.max(0, d.summary.budgetSpent - tx.amount)
        if (tx.type === 'material') d.summary.materialSpend = Math.max(0, d.summary.materialSpend - tx.amount)
        d.summary.budgetSpentPct = d.summary.budgetTotal
          ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
          : 0
      }
      break
    }
    case 'material.create': {
      d.materials.push({
        id: uid(), name: String(payload.name), unit: String(payload.unit), unitPrice: Number(payload.unitPrice) || 0,
        deliveredQty: 0, deliveredCost: 0, consumedQty: 0, onSiteQty: 0, stockValue: 0, deliveries: [],
        lowStock: false, // #207: zero inflow is never low (the rule's own guard)
        createdAt: new Date(), updatedAt: new Date(),
      } as never)
      break
    }
    case 'project.update': {
      const p = d.project
      if (typeof payload.name === 'string' && payload.name.trim()) p.name = payload.name.trim()
      if (typeof payload.client === 'string' && payload.client.trim()) p.client = payload.client.trim()
      if (typeof payload.clientType === 'string' && payload.clientType.trim()) p.clientType = payload.clientType
      if (typeof payload.location === 'string' && payload.location.trim()) p.location = payload.location.trim()
      if (typeof payload.status === 'string' && payload.status) p.status = payload.status
      if (typeof payload.startDate === 'string') p.startDate = new Date(payload.startDate) as never
      if (typeof payload.targetDate === 'string') p.targetDate = new Date(payload.targetDate) as never
      if (typeof payload.budget === 'number' && payload.budget > 0) {
        p.budget = payload.budget
        // Rescale phase budgets proportionally (same rule as the server)
        const currentTotal = d.phases.reduce((s, ph) => s + ph.budget, 0)
        if (currentTotal > 0 && d.phases.length) {
          const scale = payload.budget / currentTotal
          for (const ph of d.phases) ph.budget = Math.round(ph.budget * scale)
        }
        d.summary.budgetTotal = d.phases.reduce((s, ph) => s + ph.budget, 0)
        d.summary.budgetSpentPct = d.summary.budgetTotal
          ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
          : 0
      }
      break
    }
    case 'wages.pay': {
      for (const w of d.workers) {
        if (w.todayStatus.status && !w.todayStatus.paid) {
          w.todayStatus.paid = true
          d.summary.wagesUnpaid = Math.max(0, d.summary.wagesUnpaid - w.todayStatus.wage)
        }
      }
      break
    }
    case 'alert.ack': {
      const a = d.alerts.find((x) => x.id === payload.id)
      if (a) { a.acknowledged = true; d.summary.unackedAlerts = Math.max(0, d.summary.unackedAlerts - 1) }
      break
    }
    case 'photo.apply': {
      const p = d.phases.find((x) => x.id === payload.phaseId)
      if (p && typeof payload.progressPct === 'number' && payload.progressPct > p.progress) {
        p.progress = payload.progressPct
        p.progressManual = payload.progressPct
        if (payload.progressPct >= 100) p.status = 'done'
      }
      break
    }
    // ---- Money / Evidence optimistic cases (best-effort mirrors of server modules) ----
    case 'escrow.topup': {
      const amount = Number(payload.amount) || 0
      if (amount > 0) {
        if (d.escrow) d.escrow.balance += amount
        else d.escrow = { id: uid(), projectId: d.project.id, balance: amount, createdAt: new Date(), updatedAt: new Date() } as never
      }
      break
    }
    case 'milestone.decide': {
      const m = d.milestones.find((x) => x.id === payload.id)
      if (m && m.status === 'release_requested') {
        if (payload.decision === 'approve') {
          m.status = 'released'
          m.releasedAt = new Date() as never
          if (d.escrow) d.escrow.balance = Math.max(0, d.escrow.balance - m.amount)
        } else {
          m.status = 'rejected'
        }
        m.decidedBy = String(payload.by ?? 'Client')
        m.decidedAt = new Date() as never
        if (typeof payload.note === 'string' && payload.note.trim()) m.decisionNote = payload.note.trim()
      }
      break
    }
    case 'variation.decide': {
      const v = d.variations.find((x) => x.id === payload.id)
      if (v && v.status === 'submitted') {
        v.status = payload.decision === 'approve' ? 'approved' : 'rejected'
        v.decidedBy = String(payload.by ?? 'Client')
        v.decidedAt = new Date() as never
        if (typeof payload.note === 'string' && payload.note.trim()) v.decisionNote = payload.note.trim()
      }
      break
    }
    case 'comment.add': {
      const text = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (payload.photoId && text) {
        d.photoComments.unshift({
          id: uid(), photoId: String(payload.photoId), projectId: d.project.id,
          author: String(payload.author ?? 'Client'), role: String(payload.role ?? 'client'),
          message: text, resolved: false, createdAt: new Date(),
        } as never)
      }
      break
    }
    case 'notification.read': {
      const n = d.notifications.find((x) => x.id === payload.id)
      if (n) n.read = true
      break
    }
    case 'notification.readAll': {
      for (const n of d.notifications) n.read = true
      break
    }
    case 'zone.create': {
      const name = typeof payload.name === 'string' ? payload.name.trim() : ''
      if (name) {
        d.zones.push({
          id: uid(), projectId: d.project.id, name,
          x: Math.max(0, Math.min(100, Number(payload.x) || 0)),
          y: Math.max(0, Math.min(100, Number(payload.y) || 0)),
          w: Math.max(4, Math.min(100, Number(payload.w) || 20)),
          h: Math.max(4, Math.min(100, Number(payload.h) || 14)),
          createdAt: new Date(),
        } as never)
      }
      break
    }
    case 'zone.delete': {
      const zi = d.zones.findIndex((z) => z.id === payload.id)
      if (zi >= 0) {
        const [z] = d.zones.splice(zi, 1)
        for (const p of d.photos) if (p.zoneId === z.id) p.zoneId = null
      }
      break
    }
  }
  return d
}

export const useMjengo = create<MjengoState>()(
  persist(
    (set, get) => ({
      data: null,
      projects: [],
      activeProjectId: null,
      viewMode: 'owner',
      shareToken: null,
      clientRole: false,
      shareError: null,
      notificationsSeenAt: null,
      actionBusy: null,
      loading: true,
      online: true,
      syncing: false,
      outbox: [],
      syncHistory: [],
      lastSyncAt: null,
      persistDegraded: false,
      persistQueueOnly: false,
      pendingNetwork: [],
      dataMode: 'normal',

      setDataMode: (m) => {
        set({ dataMode: m })
        toast.success(m === 'data_saver'
          ? 'Data Saver on — photos are compressed before upload, background calls reduced'
          : 'Data Saver off — normal uploads and background calls')
      },

      bootFromShare: async (token: string, fromUrl = false) => {
        set({ loading: !get().data, shareError: null })
        try {
          const res = await fetch(`/api/share?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
          if (res.status === 404 || !res.ok) {
            // A dead token in the URL deserves the invalid-link screen; a stale
            // persisted token (owner reseeded/regenerated) silently falls back to owner mode.
            if (fromUrl) {
              set({ shareError: t('share.error.invalid'), loading: false, shareToken: null })
            } else {
              set({ shareToken: null, viewMode: 'owner' })
              await get().load()
            }
            return
          }
          const json = await res.json()
          if (!json?.ok || !json.data) {
            if (fromUrl) {
              set({ shareError: t('share.error.invalid'), loading: false, shareToken: null })
            } else {
              set({ shareToken: null, viewMode: 'owner' })
              await get().load()
            }
            return
          }
          // FE-6a: a share boot owns the screen — invalidate any in-flight
          // load()/switchProject() response so it cannot clobber share data.
          ++loadSeq
          set({
            data: json.data as ProjectPayload,
            activeProjectId: (json.data as ProjectPayload).project.id,
            viewMode: 'client',
            shareToken: token,
            shareError: null,
            loading: false,
          })
        } catch {
          // Network failure on a persisted token → still allow owner mode fallback
          if (fromUrl) {
            set({ shareError: t('share.error.network'), loading: false })
          } else {
            set({ shareToken: null, viewMode: 'owner', loading: false })
            await get().load()
          }
        }
      },

      load: async () => {
        // FE-6a (issue #80): capture the sequence token — if a newer
        // load()/switchProject()/createProject() starts before this one's
        // fetches resolve, every set() below is skipped (a stale response
        // must not overwrite newer data or stop a newer spinner).
        const seq = ++loadSeq
        set({ loading: !get().data })
        try {
          const { activeProjectId } = get()
          const [projectsRes, projectRes] = await Promise.all([
            fetch('/api/projects', { cache: 'no-store' }),
            fetch(`/api/project${activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''}`, { cache: 'no-store' }),
          ])
          if (seq !== loadSeq) return // superseded — the newer request owns the screen
          const projectsJson = projectsRes.ok ? await projectsRes.json().catch(() => null) : null
          const listLoaded = Boolean(projectsJson?.ok)
          const projects: ProjectListItem[] = listLoaded ? (projectsJson.projects as ProjectListItem[]) : get().projects
          if (listLoaded && projects.length === 0) {
            // Fresh install — no projects yet, show the welcome screen
            set({ projects: [], data: null, activeProjectId: null, loading: false })
            return
          }
          if (projectRes.ok) {
            const data = (await projectRes.json()) as ProjectPayload
            if (seq !== loadSeq) return // superseded while parsing
            set({ data, projects, activeProjectId: data.project.id, loading: false })
          } else {
            // Active project may have been deleted — fall back to the first project
            const fallbackRes = await fetch('/api/project', { cache: 'no-store' })
            if (seq !== loadSeq) return // superseded while fetching the fallback
            if (fallbackRes.ok) {
              const data = (await fallbackRes.json()) as ProjectPayload
              if (seq !== loadSeq) return
              set({ data, projects, activeProjectId: data.project.id, loading: false })
            } else {
              set({ projects, loading: false })
            }
          }
        } catch {
          // A stale request's failure belongs to the newer owner — never stop
          // its spinner or flash error state on its behalf.
          if (seq === loadSeq) set({ loading: false })
        }
      },

      switchProject: async (id) => {
        const { data, activeProjectId } = get()
        if (id === activeProjectId && data?.project?.id === id) return
        // FE-6a: the optimistic activeProjectId set below is kept (the store's
        // current id drives the UI immediately); the token discards a LATE
        // stale response so it can neither swap `data` back to the old project
        // nor fire its "Switched to …" toast after a newer switch landed.
        const seq = ++loadSeq
        set({ loading: true, activeProjectId: id })
        try {
          const res = await fetch(`/api/project?projectId=${encodeURIComponent(id)}`, { cache: 'no-store' })
          if (seq !== loadSeq) return // superseded — a newer switch owns the screen
          if (res.ok) {
            const newData = (await res.json()) as ProjectPayload
            if (seq !== loadSeq) return // superseded while parsing
            set({ data: newData, activeProjectId: newData.project.id, loading: false })
            toast.success(`Switched to ${newData.project.name}`)
          } else {
            set({ loading: false })
            toast.error('Could not open that project')
          }
        } catch {
          if (seq !== loadSeq) return
          set({ loading: false })
          toast.error('Network error — could not switch project')
        }
      },

      createProject: async (payload) => {
        try {
          const res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const json = await res.json()
          if (json.ok && json.data) {
            // FE-6a: the created project owns the screen — invalidate any
            // in-flight load()/switchProject() response so stale server data
            // cannot clobber the fresh project view.
            ++loadSeq
            set({
              data: json.data,
              projects: (json.projects ?? get().projects) as ProjectListItem[],
              activeProjectId: json.result.id,
              lastSyncAt: Date.now(),
              loading: false,
            })
            return true
          }
          console.error('create project failed', json.error)
          return false
        } catch (e) {
          console.error('create project failed', e)
          return false
        }
      },

      setViewMode: (v) => set({ viewMode: v }),

      setOnline: (v) => {
        const wasOnline = get().online
        set({ online: v })
        if (!v) {
          // Going offline parks the auto-retry schedule (#132): nothing
          // useful can drain without a network, and the next offline→online
          // transition re-runs the retry pass below.
          clearAutoRetryTimer()
          return
        }
        if (wasOnline) return
        // Fresh reconnect (#132): failed items whose bounded backoff has
        // elapsed re-queue NOW, joining the pending drain below — most
        // failures are transient (timeout, 5xx, connectivity flapping), so
        // the field user's red items recover without touching the panel.
        requeueDueFailedItems()
        const pendingCount = get().outbox.filter((o) => (o.syncStatus ?? 'pending') === 'pending').length
        const conflictCount = get().outbox.filter((o) => o.syncStatus === 'conflict').length
        if (pendingCount > 0) {
          // Real reconnection (or ending a simulated-offline run): drain the queue.
          toast.success(t('sync.backOnlineDraining'))
          void get().syncNow()
        } else if (conflictCount > 0) {
          // Nothing queued, but unresolved conflicts still need a human decision (§41).
          toast.info(t('sync.backOnlineConflicts', { count: conflictCount }))
        } else {
          toast.success(t('sync.backOnline'))
        }
        // #150: online-only refusals remembered from this offline stretch —
        // the worklist surfaces itself alongside the outbox toast (two
        // distinct intents: the queue drains itself, waiting actions need a
        // human tap). Remind-only: the entries STAY for the panel's
        // retry/discard — reconnect never consumes them.
        const waitingCount = get().pendingNetwork.length
        if (waitingCount > 0) {
          toast.info(t('sync.backOnlineWaiting', { count: waitingCount }))
        }
        // Not-yet-due failures keep their bounded schedule while online.
        armAutoRetryTimer()
      },

      dispatch: async (type, payload, label) => {
        const { viewMode, shareToken, clientRole } = get()
        // Real client on a share link: only the decision allowlist goes through /api/share
        if (viewMode === 'client' && shareToken && CLIENT_ACTION_LIST.includes(type)) {
          set({ actionBusy: label })
          try {
            const res = await fetch('/api/share', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: shareToken, type, payload }),
            })
            const json = await res.json()
            if (json.ok && json.data) {
              set({ data: json.data, lastSyncAt: Date.now() })
              return true
            }
            // FE-6b (issue #80): surface the server's refusal to the USER, not
            // just the console — generic per-surface copy can't say WHY
            // (validation, lockout, flag-off 403). Same pattern as money-tab's
            // aiReview, via the W7 store-level t().
            toast.error(serverRefusalToast(json))
            console.error('client action failed', json.error)
            return false
          } catch {
            return false
          } finally {
            set({ actionBusy: null })
          }
        }
        // Logged-in client-role user (session cookie is the auth): same allowlist via /api/actions
        if (viewMode === 'client' && !shareToken && clientRole && CLIENT_ACTION_LIST.includes(type)) {
          set({ actionBusy: label })
          try {
            const projectId = get().data?.project?.id ?? get().activeProjectId ?? undefined
            const res = await fetch('/api/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, payload, projectId }),
            })
            const json = await res.json()
            if (json.ok && json.data) {
              set({ data: json.data, lastSyncAt: Date.now() })
              return true
            }
            // FE-6b (issue #80): same honest-refusal surfacing as the share path.
            toast.error(serverRefusalToast(json))
            console.error('client-role action failed', json.error)
            return false
          } catch {
            return false
          } finally {
            set({ actionBusy: null })
          }
        }
        if (viewMode === 'client') {
          toast.info(t('sync.readOnlyClient'))
          return false
        }
        const { online } = get()
        const projectId = get().data?.project?.id ?? get().activeProjectId ?? undefined
        if (online) {
          set({ actionBusy: label })
          try {
            const res = await fetch('/api/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, payload, projectId }),
            })
            const json = await res.json()
            if (json.ok && json.data) {
              set({
                data: json.data,
                projects: (json.projects ?? get().projects) as ProjectListItem[],
                lastSyncAt: Date.now(),
              })
              return true
            }
            // FE-6b (issue #80): the server's refusal reaches the toast, not
            // just console.error — users can finally act on the REAL reason
            // (duplicate material, payment lock, flag-off 403…).
            toast.error(serverRefusalToast(json))
            console.error('action failed', json.error)
            return false
          } catch {
            // Network-level failure while we believed we were online (dropped
            // connection, server unreachable): mirror the simulated-offline
            // branch — optimistic local write + queue for sync — so a field
            // user never silently loses an action.
            const data = get().data
            const queuedPayload = data ? stampBaseVersion(data, type, payload) : payload
            const item: OutboxItem = { id: uid(), type, payload: queuedPayload, label, createdAt: Date.now(), projectId: projectId ?? null, syncStatus: 'pending', retryCount: 0 }
            if (data) set({ data: reduceLocal(data, type, queuedPayload) })
            set({ outbox: [...get().outbox, item] })
            // #193: queued while the network lied about being up — register the
            // one-shot Background Sync tag so Chromium re-launches the SW (and
            // pings any open client) when connectivity actually returns.
            registerOutboxBackgroundSync()
            // FE-6c (issue #80): honest queued copy. Callers branch their
            // success toast on `online` from their render closure — still
            // true here — so they would fire the ONLINE copy for a write that
            // only landed on-device. dispatch is the only place that KNOWS the
            // action was queued, so it fires the queued copy itself
            // ('field.savedQueued'); the explicit-offline branch below does
            // NOT (callers already show the queued copy when online is false).
            toast.success(t('field.savedQueued', { count: get().outbox.length }))
            return true
          } finally {
            set({ actionBusy: null })
          }
        }
        // Offline: optimistic local write + queue for sync. The queued payload
        // carries the client's known entity baseVersion (issue: outbox entity
        // versions) so the server can reject a stale flush honestly.
        const data = get().data
        const queuedPayload = data ? stampBaseVersion(data, type, payload) : payload
        const item: OutboxItem = { id: uid(), type, payload: queuedPayload, label, createdAt: Date.now(), projectId: projectId ?? null, syncStatus: 'pending', retryCount: 0 }
        if (data) set({ data: reduceLocal(data, type, queuedPayload) })
        set({ outbox: [...get().outbox, item] })
        // #193: queued offline — register the one-shot Background Sync tag so
        // the browser asks for a drain the moment the radio comes back, even
        // if this page is gone by then (the enqueue is what re-arms it).
        registerOutboxBackgroundSync()
        return true
      },

      applyLocal: (type, payload) => {
        const data = get().data
        if (data) set({ data: reduceLocal(data, type, payload) })
      },

      getConflicts: () => get().outbox.filter((o) => o.syncStatus === 'conflict'),

      /**
       * Drain loop (spec §40): flush every PENDING item through POST /api/sync.
       * Per-item outcomes mark the lifecycle: synced | failed | conflict.
       *   · synced + resolved items move into `syncHistory` (retained, capped — never silently lost)
       *   · failed items stay queued with retryCount + lastError and a BOUNDED
       *     auto-retry schedule (#132: 5s → 30s → 2min, max 3 automatic
       *     attempts, then manual-only via retryAll)
       *   · conflict items stay with the server's reason + rule until a human resolves them (§41)
       * A network-level failure re-queues items as pending (nothing is ever dropped).
       *
       * #191 — server-level refusals are never silent either: a 401 (session
       * expired mid-offline) marks the batch auth-blocked with a
       * session-expired lastError + toast, and any other non-ok drain response
       * (500/429/403…) marks items failed with the surfaced reason. The old
       * `json?.ok`-falsy path silently reverted everything to 'pending', so an
       * expired session stranded the outbox invisibly (nothing ever re-drained
       * after re-login — see drainAfterAuth).
       */
      syncNow: async () => {
        if (get().syncing) return
        const queue = get().outbox.filter((o) => (o.syncStatus ?? 'pending') === 'pending')
        if (!queue.length) { set({ lastSyncAt: Date.now() }); return }
        const sentIds = new Set(queue.map((q) => q.id))
        set({
          syncing: true,
          outbox: get().outbox.map((o) => (sentIds.has(o.id) ? { ...o, syncStatus: 'syncing' as const } : o)),
        })
        try {
          const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              actions: queue.map(({ id, type, payload, projectId }) => ({ id, type, payload, projectId })),
            }),
          })
          // #191: an expired session refuses the WHOLE batch for auth, not
          // data — mark it auth-blocked (failed + session-expired lastError)
          // and tell the user their work is safe and will sync after sign-in.
          // drainAfterAuth() re-queues the batch once a session returns; the
          // login screen also acknowledges the queued count (#191).
          if (res.status === 401) {
            const json = await res.json().catch(() => null)
            console.error('sync refused: session expired', json && typeof json === 'object' ? (json as { error?: unknown }).error : res.status)
            set({
              outbox: get().outbox.map((o) => (o.syncStatus === 'syncing'
                ? {
                    ...o,
                    syncStatus: 'failed' as const,
                    authBlocked: true,
                    lastError: t('sync.authBlockedItem'),
                    retryCount: (o.retryCount ?? 0) + 1,
                  }
                : o)),
            })
            toast.error(t('sync.sessionExpired', { count: queue.length }))
            return { synced: 0, failed: queue.length, conflicts: 0 }
          }
          // Defensive parse: a non-JSON error body (proxy 502 page) must not
          // fall into the network-failure catch — the server DID answer.
          const json = await res.json().catch(() => null)
          if (json?.ok) {
            const results = (json.results ?? []) as SyncItemResult[]
            const byId = new Map(results.map((r) => [r.id, r]))
            let synced = 0, failed = 0, conflicts = 0
            const marked = get().outbox.map((o) => {
              const r = byId.get(o.id)
              if (!r) return o // not part of this drain
              if (r.ok) { synced += 1; return { ...o, syncStatus: 'synced' as const, syncedAt: Date.now(), lastError: undefined } }
              if ('conflict' in r) {
                conflicts += 1
                return {
                  ...o,
                  syncStatus: 'conflict' as const,
                  conflictReason: r.reason,
                  conflictRule: r.rule,
                  conflictAt: Date.now(),
                  // Entity-version rejection metadata (stale-version rejections;
                  // undefined on plain semantic conflicts — additive shape).
                  conflictStatus: r.status,
                  conflictServerVersion: r.serverVersion,
                  conflictBaseVersion: r.baseVersion,
                  suggestion: r.suggestion,
                }
              }
              failed += 1
              return {
                ...o,
                syncStatus: 'failed' as const,
                lastError: r.error,
                retryCount: (o.retryCount ?? 0) + 1,
                // #132: schedule the bounded automatic retry (skipped once
                // the 3 attempts are used up — the panel footer is the
                // manual escape hatch from there on).
                ...withAutoRetrySchedule(o),
              }
            })
            // Retain: live queue keeps pending/syncing/failed/conflict; synced items → history (capped).
            const live = marked.filter((o) => o.syncStatus !== 'synced')
            const finished = marked.filter((o) => o.syncStatus === 'synced')
            set({
              outbox: live,
              syncHistory: [...get().syncHistory, ...finished].slice(-SYNC_HISTORY_CAP),
              data: json.data ?? get().data,
              projects: (json.projects ?? get().projects) as ProjectListItem[],
              lastSyncAt: Date.now(),
            })
            if (conflicts > 0) {
              toast.warning(
                t('sync.doneConflicts', { synced, total: results.length, conflicts }),
              )
            } else if (failed > 0) {
              toast.error(t('sync.doneFailed', { synced, failed }))
            } else if (synced > 0) {
              toast.success(t('sync.doneOk', { count: synced }))
            }
            return { synced, failed, conflicts }
          }
          // #191: any other server-level rejection (500/429/403…) is SURFACED,
          // never silently re-queued as pending: items keep their place as
          // failed with the server's reason as lastError (the panel's retry
          // footer is the recovery UI), and the toast says the queue is safe
          // on-device. Only a TRUE network-level failure (the catch below)
          // re-queues as pending.
          const reason =
            json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' && (json as { error: string }).error.trim()
              ? (json as { error: string }).error
              : t('sync.applyFailed')
          console.error('sync refused', json && typeof json === 'object' ? (json as { error?: unknown }).error : res.status)
          set({
            outbox: get().outbox.map((o) => (o.syncStatus === 'syncing'
              ? {
                  ...o,
                  syncStatus: 'failed' as const,
                  lastError: reason,
                  retryCount: (o.retryCount ?? 0) + 1,
                  // #132: bounded auto-retry applies to server-level refusals
                  // too (most are transient 5xx/429s).
                  ...withAutoRetrySchedule(o),
                }
              : o)),
          })
          toast.error(t('sync.drainFailed', { count: queue.length, reason }))
          return { synced: 0, failed: queue.length, conflicts: 0 }
        } catch (e) {
          console.error('sync failed', e)
          // Network failure mid-drain: nothing applied client-side — re-queue, never drop.
          set({ outbox: get().outbox.map((o) => (o.syncStatus === 'syncing' ? { ...o, syncStatus: 'pending' as const } : o)) })
        } finally {
          set({ syncing: false })
          // #132: arm the single auto-retry timer for any freshly-scheduled
          // failures (no-op when nothing is scheduled).
          armAutoRetryTimer()
        }
      },

      /**
       * Human conflict resolution (spec §41):
       *  · 'keep-server'   — the server version stands; the optimistic local write is
       *                      discarded by reloading server truth; the item is retained
       *                      in history with the reason.
       *  · 'keep-mine'     — re-submitted with force:true. The server applies the local
       *                      version for human-decides conflicts; for financial rows
       *                      (rule 'server-wins') it refuses honestly and the item
       *                      STAYS a conflict — money is never silently overwritten.
       */
      resolveConflict: async (id, choice) => {
        const item = get().outbox.find((o) => o.id === id)
        if (!item || item.syncStatus !== 'conflict') {
          toast.error(t('sync.notUnresolved'))
          return false
        }
        if (choice === 'keep-server') {
          const resolved: OutboxItem = { ...item, syncStatus: 'synced', syncedAt: Date.now(), resolution: 'keep-server' }
          set({
            outbox: get().outbox.filter((o) => o.id !== id),
            syncHistory: [...get().syncHistory, resolved].slice(-SYNC_HISTORY_CAP),
          })
          // Reload server truth so the local optimistic write is visibly undone.
          await get().load()
          toast.success(t('sync.keptServer', { label: item.label }))
          return true
        }
        // keep-mine: force one honest re-apply of the local version.
        if (get().syncing) { toast.info(t('sync.syncRunning')); return false }
        set({ syncing: true })
        try {
          const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              actions: [{ id: item.id, type: item.type, payload: item.payload, projectId: item.projectId, force: true }],
            }),
          })
          const json = await res.json()
          const r = (json?.results ?? [])[0] as SyncItemResult | undefined
          if (json?.ok && r?.ok) {
            const resolved: OutboxItem = { ...item, syncStatus: 'synced', syncedAt: Date.now(), resolution: 'keep-mine-applied' }
            set({
              outbox: get().outbox.filter((o) => o.id !== id),
              syncHistory: [...get().syncHistory, resolved].slice(-SYNC_HISTORY_CAP),
              data: json.data ?? get().data,
              projects: (json.projects ?? get().projects) as ProjectListItem[],
              lastSyncAt: Date.now(),
            })
            toast.success(t('sync.keptMine', { label: item.label }))
            return true
          }
          if (json?.ok && r && 'conflict' in r) {
            // Deterministic refusal (financial rows: server always wins). Stays a conflict.
            set({ outbox: get().outbox.map((o) => (o.id === id ? { ...o, conflictReason: r.reason } : o)) })
            toast.error(t('sync.serverRefused', { reason: r.reason }))
            return false
          }
          const msg = r && 'error' in r ? r.error : (json?.error ?? t('sync.applyFailed'))
          toast.error(msg)
          return false
        } catch {
          toast.error(t('sync.resolveNetwork'))
          return false
        } finally {
          set({ syncing: false })
        }
      },

      /**
       * Manual retry pass for hard-failed items — the human escape hatch the
       * bounded auto-retry (#132) falls back to once its 3 attempts are
       * exhausted (and an immediate override before that). Overrides any
       * pending backoff schedule: the items are re-queued right now.
       */
      retryAll: () => {
        const failed = get().outbox.filter((o) => o.syncStatus === 'failed')
        if (!failed.length) { toast.info(t('sync.nothingFailed')); return }
        set({ outbox: get().outbox.map((o) => (o.syncStatus === 'failed'
          ? { ...o, syncStatus: 'pending' as const, nextAttemptAt: undefined }
          : o)) })
        toast.success(t('sync.retrying', { count: failed.length }))
        void get().syncNow()
      },

      /**
       * #191 — re-login recovery. A reconnect drain that hit an expired
       * session left the queue auth-blocked (failed + authBlocked), and after
       * re-login nothing transitions offline→online (the flag is already
       * true), so the queue would strand forever. app.tsx calls this when a
       * session authenticates: auth-blocked items are re-queued, and the
       * pending queue is flushed once (when online). Deliberately silent —
       * syncNow owns the result toasts.
       */
      drainAfterAuth: async () => {
        const authBlocked = get().outbox.filter((o) => o.syncStatus === 'failed' && o.authBlocked)
        if (authBlocked.length > 0) {
          set({
            outbox: get().outbox.map((o) => (o.syncStatus === 'failed' && o.authBlocked
              ? { ...o, syncStatus: 'pending' as const, authBlocked: false, lastError: undefined, nextAttemptAt: undefined }
              : o)),
          })
        }
        // #132: a session boot is also a fine moment to restore the
        // auto-retry timer (covers a reload with scheduled failures; no-op
        // when nothing is scheduled).
        armAutoRetryTimer()
        const hasPending = get().outbox.some((o) => (o.syncStatus ?? 'pending') === 'pending')
        if (!get().online || !hasPending || get().syncing) return false
        await get().syncNow()
        return true
      },

      /**
       * #150 — record an online-only refusal. The refusal toast stays the
       * immediate honesty (the guards keep firing it); this is the MEMORY of
       * the intent so the reconnect toast + the header panel can offer a
       * retry. One entry per INTENT (kind + context): a repeated attempt
       * refreshes the reminder's timestamp instead of stacking duplicates —
       * the worklist is a to-do surface, not an attempt log.
       */
      enqueuePendingNetwork: (entry) => {
        const list = get().pendingNetwork
        const sig = JSON.stringify([entry.kind, entry.context ?? null])
        const existing = list.find((i) => JSON.stringify([i.kind, i.context ?? null]) === sig)
        if (existing) {
          set({
            pendingNetwork: list.map((i) =>
              i.id === existing.id ? { ...i, createdAt: Date.now() } : i),
          })
          return
        }
        const item: PendingNetworkItem = { id: uid(), createdAt: Date.now(), ...entry }
        // Newest-kept cap (PENDING_NETWORK_CAP): overflow drops the OLDEST
        // reminders — the freshest intents are the ones still actionable.
        set({ pendingNetwork: [...list, item].slice(-PENDING_NETWORK_CAP) })
      },

      /** #150 — drop one reminder. Human-only lifecycle: discard (or a consumed Retry-now); nothing else removes entries. */
      discardPendingNetwork: (id) => {
        set({ pendingNetwork: get().pendingNetwork.filter((i) => i.id !== id) })
      },
    }),
    {
      name: MJENGO_STORE_KEY,
      version: 1,
      // #192 — the guarded adapter: write failures (quota / private mode)
      // are caught + surfaced, and a quota failure retries once with the
      // re-fetchable data slice dropped so the mutation queue still banks.
      // The typeof guard keeps node/SSR byte-identical to the old default
      // storage (createJSONStorage returns undefined when getStorage
      // throws → persist inert — no phantom localStorage in tests/server).
      storage: createJSONStorage(() => {
        if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable')
        return guardedLocalStorage
      }),
      // v0 → v1: outbox items gain the §40 lifecycle fields; old items become
      // 'pending' so a pre-upgrade queue still drains exactly as before.
      migrate: (persisted: unknown) => {
        const s = (persisted ?? {}) as Partial<MjengoState> & { outbox?: OutboxItem[] }
        return {
          ...s,
          outbox: (s.outbox ?? []).map(normalizeOutboxItem),
          syncHistory: (s.syncHistory ?? []).map(normalizeOutboxItem),
        } as MjengoState
      },
      onRehydrateStorage: () => (state, error) => {
        // #192: a hydration failure (unreadable/corrupted key) is ALSO a
        // persistence degradation — surface it, never swallow it.
        if (error) setPersistHealth('degraded')
        // Belt-and-braces: any stale shape is normalised after rehydration.
        if (state?.outbox) state.outbox = state.outbox.map(normalizeOutboxItem)
        if (state?.syncHistory) state.syncHistory = state.syncHistory.map(normalizeOutboxItem)
        // #192: orphaned 'syncing' items → 'pending'. A persisted 'syncing'
        // item is by definition a snapshot written MID-DRAIN (persist writes
        // on every setState): the drain that marked it either completed in
        // the writing surface (whose result snapshot carries the outcome) or
        // died with it. No drain owns it in THIS surface — without this it
        // strands forever showing “Syncing…” (syncNow only drains 'pending').
        // The cross-tab rehydrate below rides the same normalization.
        const orphaned = state?.outbox?.some((o) => o.syncStatus === 'syncing') ?? false
        // #132: restore the auto-retry schedule after a reload — the persisted
        // nextAttemptAt stamps survive, the timer itself does not. Deferred a
        // tick because this callback can run while the module is still
        // initialising (useMjengo is in its TDZ then); inert in node/tests
        // (no storage → zustand never calls this back there).
        setTimeout(() => armAutoRetryTimer(), 0)
        if (orphaned) {
          // Same deferral reason (TDZ): return the orphaned 'syncing' items
          // to the drainable 'pending' state a tick after the merge.
          setTimeout(() => {
            useMjengo.setState({
              outbox: useMjengo.getState().outbox.map((o) =>
                o.syncStatus === 'syncing' ? { ...o, syncStatus: 'pending' as const } : o),
            })
          }, 0)
        }
      },
      partialize: (s) => ({
        // #192 BOUNDING DECISION (documented, not faked): `data` STAYS
        // persisted. The offline boot (issue #78 — offline-boot.ts
        // shouldOfflineBoot) serves `data` straight from this key when the
        // app relaunches with no network; dropping it would trade a size
        // win for breaking every offline read. There are no photo BLOBS to
        // strip (SitePhoto.url is a server URL — bytes live in the SW's
        // LRU-capped CacheStorage, never here), and the server reads are
        // already take-capped (#105/#154/#155), so `data` is bounded by the
        // project's own lifetime rows. The measured size budget for a
        // representative large project + 100 queued actions is pinned by
        // tests/unit/outbox-persistence.test.ts. The outbox stays
        // unbounded BY DESIGN (spec §52 — the live queue is never pruned:
        // pruning it IS data loss, the exact thing #192 protects against);
        // the quota-guarded adapter above + its queue-only fallback are the
        // loud backstop when the device runs out anyway.
        online: s.online,
        outbox: s.outbox,
        syncHistory: s.syncHistory,
        // #150 PERSISTENCE DECISION (documented, not faked): the waiting
        // worklist IS persisted. These are tiny REMINDER entries (kind +
        // dict key + timestamp + short context vars — never payloads,
        // never blobs), and a reload losing them would resurrect the exact
        // "user must remember" failure the issue exists to fix. Deliberately
        // SEPARATE from the outbox: outbox items are drained mutations with
        // a §40 lifecycle; these are intent reminders with a human-only
        // lifecycle, capped at PENDING_NETWORK_CAP so the key stays small.
        pendingNetwork: s.pendingNetwork,
        data: s.data,
        lastSyncAt: s.lastSyncAt,
        activeProjectId: s.activeProjectId,
        shareToken: s.shareToken,
        dataMode: s.dataMode,
      }),
    },
  ),
)

/**
 * #192 — cross-tab rehydration (the browser `storage` event).
 *
 * zustand-persist does NOT listen for `storage`: with two surfaces open
 * (installed PWA window + browser tab) each surface's writes are invisible
 * to the other, and the stale surface's next write clobbers the newer
 * snapshot wholesale — an older outbox can wipe newer queued mutations.
 *
 * v1 semantics (deliberate, documented): DEBOUNCED LAST-WRITER-WINS WITH
 * REHYDRATE. When another surface writes our key, this surface re-reads it
 * (persist.rehydrate() → shallow merge of the partialized keys) within a
 * short trailing debounce (persist writes on every setState, so an active
 * peer emits bursts). A CRDT is explicitly NOT wanted: true conflicts are
 * already arbitrated server-side (§41 rules + per-row baseVersion
 * rejections — outbox-versions.test.ts); a client-side CRDT would duplicate
 * that machinery and still could not decide a semantic conflict.
 * Honest v1 limits: a rehydrate can momentarily revert an in-flight drain's
 * 'syncing' items to the peer's snapshot state (the orphan normalization in
 * onRehydrateStorage returns them to 'pending'; the server's versioned
 * appliers arbitrate any double-flush), and a key CLEARED by another tab
 * (storage event with key === null) is ignored — this surface keeps working
 * from memory and its next write re-creates the key.
 */

/** Debounce window for cross-tab rehydrates (#192). */
export const CROSS_TAB_REHYDRATE_DEBOUNCE_MS = 250

/**
 * Pure decision (#192): only writes to OUR key rehydrate. `key === null` is
 * a clear() from another surface — deliberately NOT ours to react to (see
 * the section comment).
 */
export function shouldRehydrateFromStorageEvent(e: { key: string | null }): boolean {
  return e.key === MJENGO_STORE_KEY
}

let crossTabRehydrateTimer: ReturnType<typeof setTimeout> | null = null

/** The storage-event entry point (#192): debounced rehydrate on our key's foreign writes. */
export function handleCrossTabStorageEvent(e: { key: string | null }): void {
  if (!shouldRehydrateFromStorageEvent(e)) return
  if (crossTabRehydrateTimer !== null) clearTimeout(crossTabRehydrateTimer)
  crossTabRehydrateTimer = setTimeout(() => {
    crossTabRehydrateTimer = null
    try {
      void useMjengo.persist.rehydrate()
    } catch {
      // A rehydrate must never throw into the browser's event dispatch.
    }
  }, CROSS_TAB_REHYDRATE_DEBOUNCE_MS)
}

// Registered once per page load at module scope (the store is a singleton —
// same home as the __MJENGO_DEBUG__ hook below; node/SSR have no window, so
// tests call handleCrossTabStorageEvent directly).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', handleCrossTabStorageEvent)
}

/**
 * Dev/debug console hook (W1-SYNC): `window.__MJENGO_DEBUG__()` returns the live
 * store state plus a derived `conflicts` array (outbox items awaiting a §41
 * decision) — for console verification of the sync/conflict lifecycle.
 */
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__MJENGO_DEBUG__ = () => {
    const s = useMjengo.getState()
    return { ...s, conflicts: s.outbox.filter((o) => o.syncStatus === 'conflict') }
  }
}
