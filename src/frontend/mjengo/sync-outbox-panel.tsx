// Offline outbox panel (issue "Outbox conflict metadata + entity versions").
//
// The header's Sync control becomes the trigger for this sheet, which renders
// the outbox queue PER ITEM (spec §40 lifecycle: pending → syncing → synced |
// failed | conflict) and — the new part — the entity-version REJECTION detail:
// a stale-version item shows the reason, the server version it must re-base
// onto, and the deterministic keep-server suggestion chip (§41: the server
// version is the DEFAULT suggestion — never a silent overwrite), with the two
// honest resolutions (keep server / keep mine) for human-decides rows.
// All user-visible copy runs through useT() (W7 · issue #79 — this sheet is
// the offline-critical surface); the trigger button reuses the header's
// translated labels. Server-provided conflictReason / lastError render
// verbatim — backend copy, not UI strings.
'use client'

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Check, CheckCheck, CloudOff, Loader2, RefreshCw, Smartphone, TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'

import { useMjengo, AUTO_RETRY_MAX_ATTEMPTS, type OutboxItem } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from '@/frontend/ui/sheet'
import { useT } from '@/frontend/i18n/provider'

const SCROLLBAR =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

/** Lifecycle pill for one outbox item (spec §40) — REJECTED is the stale-version state. */
function StatusPill({ item }: { item: OutboxItem }) {
  const t = useT()
  const rejected = item.syncStatus === 'conflict' && item.conflictStatus === 'REJECTED'
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: t('outbox.status.queued'), cls: 'bg-stone-100 text-stone-600' },
    syncing: { label: t('outbox.status.syncing'), cls: 'bg-blue-100 text-blue-700' },
    failed: { label: t('outbox.status.failed'), cls: 'bg-red-100 text-red-700' },
    conflict: rejected
      ? { label: t('outbox.status.rejected'), cls: 'bg-red-100 text-red-700' }
      : { label: t('outbox.status.conflict'), cls: 'bg-amber-100 text-amber-800' },
  }
  const meta = map[item.syncStatus] ?? map.pending
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${meta.cls}`}>
      {item.syncStatus === 'syncing' && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
      {meta.label}
    </span>
  )
}

/** The entity-version rejection detail (stale-version): numbers + keep-server chip. */
function StaleVersionDetail({ item }: { item: OutboxItem }) {
  const t = useT()
  if (item.conflictStatus !== 'REJECTED') return null
  const base = typeof item.conflictBaseVersion === 'number' ? item.conflictBaseVersion : null
  const server = typeof item.conflictServerVersion === 'number' ? item.conflictServerVersion : null
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-xs text-red-700 leading-snug">
        {server !== null
          ? t('outbox.rejectedVersions', { base: base ?? '?', server })
          : t('outbox.rejectedChanged')}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {server !== null && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-stone-900 text-stone-100 text-[10px] font-semibold">
            {t('outbox.serverVersion', { version: server })}
          </span>
        )}
        {item.suggestion === 'keep-server' && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10px] font-semibold border border-amber-200">
            <Check className="w-3 h-3" aria-hidden /> {t('outbox.suggested')}
          </span>
        )}
      </div>
    </div>
  )
}

/** One queued outbox item, with conflict resolution where the server rejected it. */
function OutboxRow({
  item,
  onResolve,
}: {
  item: OutboxItem
  onResolve: (id: string, choice: 'keep-server' | 'keep-mine') => void
}) {
  const t = useT()
  const isConflict = item.syncStatus === 'conflict'
  return (
    <li className="px-4 py-3 border-b border-stone-100 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-900 truncate">{item.label}</p>
          {/* FE-4 (issue #80): stone-600 on white (6.99:1) — the outbox meta
              line (type · queued-ago · attempts) was stone-400 2.31:1. */}
          <p className="text-[11px] text-stone-600 mt-0.5">
            {item.type} · {t('outbox.queuedAgo', { when: formatDistanceToNow(new Date(item.createdAt), { addSuffix: true }) })}
            {item.syncStatus === 'failed' && item.retryCount ? ` · ${t('outbox.attempts', { count: item.retryCount })}` : ''}
          </p>
        </div>
        <StatusPill item={item} />
      </div>

      {isConflict && (
        <div className="mt-1.5">
          <StaleVersionDetail item={item} />
          {item.conflictStatus !== 'REJECTED' && item.conflictReason && (
            <p className="text-xs text-amber-800 leading-snug">{item.conflictReason}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="min-h-9 h-9"
              onClick={() => onResolve(item.id, 'keep-server')}
            >
              <CheckCheck className="w-3.5 h-3.5" aria-hidden /> {t('outbox.keepServer')}
            </Button>
            {item.conflictRule !== 'server-wins' && (
              <Button
                size="sm"
                variant="outline"
                className="min-h-9 h-9"
                onClick={() => onResolve(item.id, 'keep-mine')}
              >
                {t('outbox.keepMine')}
              </Button>
            )}
            {item.conflictRule === 'server-wins' && (
              <span className="text-[10px] text-stone-600 self-center">
                {t('outbox.serverWinsNote')}
              </span>
            )}
          </div>
        </div>
      )}

      {item.syncStatus === 'failed' && item.lastError && (
        <p className="mt-1.5 text-xs text-red-700 leading-snug">{item.lastError}</p>
      )}

      {/* #132: a scheduled auto-retry replaces the bare red chip — the item
          failed, but a bounded attempt (5s → 30s → 2min, max 3) is already
          booked; once those are used up the manual footer is the only path. */}
      {item.syncStatus === 'failed' && typeof item.nextAttemptAt === 'number' && (
        <p className="mt-1 text-[11px] text-stone-600 leading-snug">
          {t('outbox.autoRetryNote', {
            attempts: item.autoAttempts ?? 0,
            max: AUTO_RETRY_MAX_ATTEMPTS,
            when: new Date(item.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })}
        </p>
      )}
      {item.syncStatus === 'failed' &&
        typeof item.nextAttemptAt !== 'number' &&
        (item.autoAttempts ?? 0) >= AUTO_RETRY_MAX_ATTEMPTS && (
        <p className="mt-1 text-[11px] text-stone-600 leading-snug">
          {t('outbox.autoRetryExhausted', { max: AUTO_RETRY_MAX_ATTEMPTS })}
        </p>
      )}

      {/* #191: an auth-blocked failure waits for a SIGN-IN, not a retry — say
          so instead of leaving a bare red chip the user can only hammer. */}
      {item.syncStatus === 'failed' && item.authBlocked && (
        <p className="mt-1 text-[11px] text-stone-600 leading-snug">
          {t('outbox.authBlockedNote')}
        </p>
      )}
    </li>
  )
}

/**
 * Header sync control + per-item outbox sheet. The trigger keeps the
 * historical Sync button (flush the queue when offline) and — #191 — stays
 * reachable whenever UNRESOLVED work exists: conflicts (a human decision),
 * failures (the retry footer), and an online + pending-only queue too. The
 * old rule disabled it while online with no conflicts, which stranded an
 * auth-blocked or pending queue with no user-reachable recovery path.
 */
export function SyncOutboxPanel() {
  const { outbox, syncing, syncNow, lastSyncAt, resolveConflict, retryAll } = useMjengo()
  const t = useT()
  const [open, setOpen] = useState(false)

  const conflicts = outbox.filter((o) => o.syncStatus === 'conflict')
  const failed = outbox.filter((o) => o.syncStatus === 'failed')
  const pending = outbox.filter((o) => o.syncStatus === 'pending')
  // Conflicts first (they need a human), then failures, then the live queue.
  const ordered = [
    ...conflicts,
    ...failed,
    ...outbox.filter((o) => o.syncStatus === 'pending' || o.syncStatus === 'syncing'),
  ]

  async function resolve(id: string, choice: 'keep-server' | 'keep-mine') {
    const ok = await resolveConflict(id, choice)
    if (ok && choice === 'keep-server' && conflicts.length === 1) setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          // #191: enabled whenever unresolved items exist — outbox only ever
          // holds pending/syncing/failed/conflict (synced items move to
          // history), so a non-empty outbox IS unresolved work. Clicking drains
          // the pending queue (online or offline); the sheet below is the
          // per-item view + conflict/retry recovery UI.
          disabled={outbox.length === 0 || syncing}
          onClick={() => {
            if (!syncing && pending.length > 0) void syncNow()
          }}
          aria-label={
            conflicts.length > 0
              ? `${t('header.aria.sync')} — ${t('outbox.aria.conflictsPending', { count: conflicts.length })}`
              : t('header.aria.sync')
          }
          className="gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white relative"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden />
          <span className="hidden sm:inline">{syncing ? t('header.syncing') : t('header.sync')}</span>
          {outbox.length > 0 && (
            <span
              className={`absolute -top-1.5 -right-1.5 ${
                conflicts.length > 0 ? 'bg-red-500' : 'bg-amber-500'
              } text-stone-950 text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center`}
              aria-label={t('header.aria.queuedActions', { count: outbox.length })}
            >
              {outbox.length > 9 ? '9+' : outbox.length}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md w-full p-0 gap-0">
        <SheetHeader className="p-4 pb-3 border-b border-stone-100">
          <SheetTitle className="text-base text-stone-900">{t('outbox.title')}</SheetTitle>
          <SheetDescription className="text-xs text-stone-600">
            {outbox.length === 0
              ? t('outbox.empty')
              : conflicts.length > 0
                ? t('outbox.metaConflicts', { count: conflicts.length, rest: outbox.length - conflicts.length })
                : t('outbox.metaQueued', { count: outbox.length })}
            {lastSyncAt ? ` · ${t('outbox.lastSync', { when: formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true }) })}` : ''}
          </SheetDescription>
          {/* #192/#351: the honest device-local note — the queue lives in THIS
              browser's storage (spec §40; per-device by architecture, issue
              #192's audit note — since #351 the indexedDB record the service
              worker can also read), not in the cloud and not on other
              devices. stone-600 on white (6.99:1) — the FE-4 contrast rule. */}
          <p className="flex items-center gap-1.5 text-[11px] text-stone-600">
            <Smartphone className="w-3 h-3 shrink-0" aria-hidden /> {t('outbox.deviceLocal')}
          </p>
        </SheetHeader>

        {outbox.length === 0 ? (
          <div className="px-4 py-10 text-center flex-1" role="status">
            <CloudOff className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">{t('outbox.allCaughtUp')}</p>
            <p className="mt-1 text-xs text-stone-600">
              {t('outbox.emptyHint')}
            </p>
          </div>
        ) : (
          <ul className="flex-1 min-h-0 max-h-[64vh] overflow-y-auto" aria-label={t('outbox.listAria')}>
            {ordered.map((o) => (
              <OutboxRow key={o.id} item={o} onResolve={(id, choice) => void resolve(id, choice)} />
            ))}
          </ul>
        )}

        {(failed.length > 0 || conflicts.length > 0) && (
          <SheetFooter className="border-t border-stone-100 p-2">
            {failed.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full min-h-11 gap-1.5 text-stone-600 hover:text-stone-900"
                onClick={retryAll}
              >
                <TriangleAlert className="w-4 h-4" aria-hidden /> {t('outbox.retryFailed', { count: failed.length })}
              </Button>
            ) : (
              <p className="w-full text-center text-[11px] text-stone-600 px-2">
                {t('outbox.conflictsStay')}
              </p>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
