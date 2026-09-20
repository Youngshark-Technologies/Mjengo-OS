// "Waiting for network" worklist panel (issue #150 / audit FE-12).
//
// The outbox's sibling surface for the OTHER half of the offline story:
// online-only flows (money payment.pay, fundis wages.pay, AI review,
// copilot analyze/voice/scan/docs, trust digest) refuse honestly with a
// toast when offline — and since #150 every refusal ALSO records a
// reminder in the store's `pendingNetwork` slice. This header sheet lists
// those reminders with Retry-now (navigates back to the flow's tab and
// consumes the reminder — completing the action stays human, the
// remind-only v1 decision documented in use-mjengo.ts) and Discard.
//
// Visibility mirrors the acceptance criteria: the trigger renders ONLY
// while entries exist (empty state hidden); the sheet itself can outlive
// the last discard (open → allCleared) so focus never vanishes mid-action.
// All copy runs through useT() (W7 · issue #79); entry labels render from
// the stored dict key + context vars at DISPLAY time, so the locale always
// follows the UI, never the enqueue moment.
'use client'

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { RotateCw, WifiOff } from 'lucide-react'

import {
  useMjengo, type PendingNetworkItem,
} from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from '@/frontend/ui/sheet'
import { useT } from '@/frontend/i18n/provider'

/** One waiting reminder: human label, when, Retry-now (online only) + Discard. */
function WaitingRow({
  item,
  online,
  onRetry,
  onDiscard,
}: {
  item: PendingNetworkItem
  online: boolean
  onRetry: (item: PendingNetworkItem) => void
  onDiscard: (id: string) => void
}) {
  const t = useT()
  return (
    <li className="px-4 py-3 border-b border-stone-100 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-900 truncate">{t(item.labelKey, item.context)}</p>
          {/* FE-4 contrast idiom (stone-600 on white, 6.99:1). */}
          <p className="text-[11px] text-stone-600 mt-0.5">
            {t('netlist.queuedAgo', { when: formatDistanceToNow(new Date(item.createdAt), { addSuffix: true }) })}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wide shrink-0">
          <WifiOff className="w-3 h-3" aria-hidden />
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* Retry is visible-but-disabled while offline (the honest affordance:
            the reminder exists, the connection does not). */}
        <Button
          size="sm"
          variant="secondary"
          className="min-h-9 h-9 gap-1.5"
          disabled={!online}
          title={online ? undefined : t('netlist.retryOfflineNote')}
          onClick={() => onRetry(item)}
        >
          <RotateCw className="w-3.5 h-3.5" aria-hidden /> {t('netlist.retryNow')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-9 h-9"
          onClick={() => onDiscard(item.id)}
        >
          {t('netlist.discard')}
        </Button>
      </div>
    </li>
  )
}

/**
 * Header control + sheet for the waiting worklist. Mounted next to the
 * notification bell on BOTH surfaces (owner + client — the trust-digest
 * generate guard is reachable from the client-visible intel tab); renders
 * NOTHING while the list is empty (acceptance: "empty state hidden").
 */
export function PendingNetworkPanel() {
  const { pendingNetwork, online, discardPendingNetwork } = useMjengo()
  const t = useT()
  const [open, setOpen] = useState(false)

  const hasWaiting = pendingNetwork.length > 0
  // Hidden when empty — unless the sheet is mid-view (the last row was just
  // discarded): the sheet then shows its own cleared note instead of
  // vanishing under the user's focus.
  if (!hasWaiting && !open) return null

  function retry(item: PendingNetworkItem) {
    // Remind-only v1: take the user back to the flow (app.tsx's
    // role-filtered 'mjengo:tab' listener — an invisible tab for this role
    // is ignored there, never guessed here) and consume the reminder.
    // Completing the action stays human; nothing auto-executes.
    window.dispatchEvent(new CustomEvent('mjengo:tab', { detail: { tab: item.tab } }))
    discardPendingNetwork(item.id)
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {hasWaiting && (
        <SheetTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label={t('netlist.aria.trigger', { count: pendingNetwork.length })}
            className="gap-1.5 border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-950 relative"
          >
            <WifiOff className="w-4 h-4" aria-hidden />
            <span className="hidden sm:inline">{t('netlist.trigger')}</span>
            <span
              className="absolute -top-1.5 -right-1.5 bg-amber-500 text-stone-950 text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center"
              aria-hidden
            >
              {pendingNetwork.length > 9 ? '9+' : pendingNetwork.length}
            </span>
          </Button>
        </SheetTrigger>
      )}
      <SheetContent side="right" className="sm:max-w-md w-full p-0 gap-0">
        <SheetHeader className="p-4 pb-3 border-b border-stone-100">
          <SheetTitle className="text-base text-stone-900">{t('netlist.title')}</SheetTitle>
          <SheetDescription className="text-xs text-stone-600">
            {hasWaiting
              ? t('netlist.meta', { count: pendingNetwork.length })
              : t('netlist.allCleared')}
          </SheetDescription>
        </SheetHeader>

        {hasWaiting ? (
          <ul className="flex-1 min-h-0 max-h-[64vh] overflow-y-auto" aria-label={t('netlist.listAria')}>
            {pendingNetwork.map((item) => (
              <WaitingRow
                key={item.id}
                item={item}
                online={online}
                onRetry={retry}
                onDiscard={discardPendingNetwork}
              />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-10 text-center flex-1" role="status">
            <WifiOff className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">{t('netlist.allCleared')}</p>
          </div>
        )}

        <div className="border-t border-stone-100 p-2">
          <p className="w-full text-center text-[11px] text-stone-600 px-2">
            {t('netlist.hint')}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
