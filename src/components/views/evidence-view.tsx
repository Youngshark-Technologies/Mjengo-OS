'use client'

// MJG-009b — Evidence: human-verified site reports.
// Human verification is the product's soul: every decision shows a named
// supervisor and a timestamp. No AI language, no automatic approvals.

import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import {
  type EvidenceDTO,
  type EvidenceStatus,
  type MilestoneDTO,
  type SessionUser,
  type SiteDTO,
} from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const UNSET = '__unset__'

// The API returns photoUrl on evidence records; the shared DTO lags behind.
type EvidenceRecord = EvidenceDTO & { photoUrl?: string | null }

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusBadgeClass(status: EvidenceStatus): string {
  switch (status) {
    case 'REPORTED':
      return 'border-amber-300 bg-amber-50 text-amber-800'
    case 'VERIFIED':
      return 'border-transparent bg-emerald-600 text-white'
    case 'REJECTED':
      return 'border-red-300 bg-red-50 text-red-700'
  }
}

function statusLabel(status: EvidenceStatus): string {
  switch (status) {
    case 'REPORTED':
      return 'Reported'
    case 'VERIFIED':
      return 'Verified'
    case 'REJECTED':
      return 'Rejected'
  }
}

function ListSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-hidden>
      {Array.from({ length: cards }).map((_, i) => (
        <Skeleton key={i} className="h-44 w-full rounded-xl" />
      ))}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <Card className="items-start gap-3 border-red-200 px-4 py-4">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-600" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-900">Couldn&apos;t load evidence</p>
          <p className="mt-0.5 break-words text-sm text-stone-500">
            {message || 'The request failed. Please try again.'}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onRetry}
        className="h-11 w-fit border-stone-300 text-stone-700"
      >
        <RefreshCw /> Retry
      </Button>
    </Card>
  )
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <Card className="items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-medium text-stone-900">{title}</p>
      <p className="mx-auto max-w-sm text-sm text-stone-500">{description}</p>
      {action}
    </Card>
  )
}

export function EvidenceView({ user }: { user: SessionUser }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<EvidenceStatus>('REPORTED')
  const [reportOpen, setReportOpen] = useState(false)

  const evidenceQuery = useQuery({
    queryKey: ['evidence'],
    queryFn: () => api.get<EvidenceRecord[]>('/api/evidence'),
  })

  const verify = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'VERIFIED' | 'REJECTED' }) =>
      api.post<EvidenceRecord>(`/api/evidence/${id}/verify`, { decision }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['evidence'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: variables.decision === 'VERIFIED' ? 'Evidence verified' : 'Evidence rejected',
        description:
          variables.decision === 'VERIFIED'
            ? 'The report now carries your name as the verifying supervisor.'
            : 'The report will not count until it is resubmitted and approved.',
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Verification failed', description: error.message }),
  })

  const counts = useMemo(() => {
    const list = evidenceQuery.data ?? []
    return {
      reported: list.filter((e) => e.status === 'REPORTED').length,
      verified: list.filter((e) => e.status === 'VERIFIED').length,
      rejected: list.filter((e) => e.status === 'REJECTED').length,
    }
  }, [evidenceQuery.data])

  const visible = useMemo(
    () => (evidenceQuery.data ?? []).filter((e) => e.status === tab),
    [evidenceQuery.data, tab],
  )

  const canDecide = user.role === 'OWNER' || user.role === 'SUPERVISOR'
  const pendingId = verify.isPending ? (verify.variables?.id ?? null) : null

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-stone-900">Evidence</h2>
          <p className="mt-0.5 text-sm text-stone-500">
            Site reports with a named human review trail.
          </p>
        </div>
        <Button
          onClick={() => setReportOpen(true)}
          className="h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600 sm:w-auto"
        >
          <Plus /> Report site evidence
        </Button>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        <p className="text-sm text-amber-900">
          Every report is reviewed by a named supervisor before it counts. No automatic approvals.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as EvidenceStatus)}
        className="gap-4"
      >
        <TabsList className="h-11 w-full sm:w-auto">
          <TabsTrigger value="REPORTED">To verify ({counts.reported})</TabsTrigger>
          <TabsTrigger value="VERIFIED">Verified ({counts.verified})</TabsTrigger>
          <TabsTrigger value="REJECTED">Rejected ({counts.rejected})</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="space-y-4">
          {evidenceQuery.isPending ? (
            <ListSkeleton />
          ) : evidenceQuery.isError ? (
            <ErrorState
              message={(evidenceQuery.error as Error | null)?.message}
              onRetry={() => evidenceQuery.refetch()}
            />
          ) : visible.length === 0 ? (
            tab === 'REPORTED' ? (
              <EmptyState
                title="Nothing to verify"
                description="No reports are waiting for review right now. New site evidence will land here."
                action={
                  <Button
                    onClick={() => setReportOpen(true)}
                    className="h-11 bg-amber-500 text-stone-950 hover:bg-amber-600"
                  >
                    <Plus /> Report site evidence
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title={tab === 'VERIFIED' ? 'No verified evidence yet' : 'No rejected reports'}
                description={
                  tab === 'VERIFIED'
                    ? 'Approved reports appear here with the name of the supervisor who verified them.'
                    : 'Rejected reports appear here for the record.'
                }
              />
            )
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {visible.map((item) => (
                <EvidenceCard
                  key={item.id}
                  item={item}
                  user={user}
                  canDecide={canDecide}
                  busy={pendingId === item.id}
                  onDecide={(decision) => verify.mutate({ id: item.id, decision })}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <ReportDialog open={reportOpen} onOpenChange={setReportOpen} />
    </div>
  )
}

/* ----------------------------- Evidence card ----------------------------- */

function EvidenceCard({
  item,
  user,
  canDecide,
  busy,
  onDecide,
}: {
  item: EvidenceRecord
  user: SessionUser
  canDecide: boolean
  busy: boolean
  onDecide: (decision: 'VERIFIED' | 'REJECTED') => void
}) {
  const mine = item.reportedById === user.id

  return (
    <Card className="gap-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-900">{item.title}</p>
          <p className="mt-1 text-xs text-stone-500">
            {item.siteName}
            {item.milestoneName ? ` · ${item.milestoneName}` : ''}
          </p>
        </div>
        <Badge className={statusBadgeClass(item.status)}>{statusLabel(item.status)}</Badge>
      </div>

      {item.description && <p className="text-sm text-stone-600">{item.description}</p>}

      <p className="text-xs text-stone-500">
        Reported by <span className="font-medium text-stone-700">{item.reportedByName}</span>
        {timeAgo(item.createdAt) ? ` · ${timeAgo(item.createdAt)}` : ''}
      </p>

      {item.status === 'VERIFIED' && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          <div className="min-w-0 text-xs text-emerald-900">
            <p>
              Verified by{' '}
              <span className="font-semibold">{item.verifiedByName ?? 'a supervisor'}</span>
            </p>
            {item.verifiedAt && (
              <p className="mt-0.5 text-emerald-700">{formatDateTime(item.verifiedAt)}</p>
            )}
          </div>
        </div>
      )}

      {item.photoUrl && (
        <a
          href={item.photoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-amber-700 underline-offset-4 hover:underline"
        >
          View photo <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}

      {canDecide && item.status === 'REPORTED' && (
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
          {mine ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button className="h-11 bg-emerald-600 text-white" disabled>
                      <ShieldCheck /> Verify
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-stone-950 text-white">
                  You reported this — another supervisor must verify it
                </TooltipContent>
              </Tooltip>
              <Button
                variant="outline"
                className="h-11 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                disabled
              >
                <XCircle /> Reject
              </Button>
            </>
          ) : (
            <>
              <Button
                className="h-11 bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={busy}
                onClick={() => onDecide('VERIFIED')}
              >
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck />} Verify
              </Button>
              <Button
                variant="outline"
                className="h-11 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                disabled={busy}
                onClick={() => onDecide('REJECTED')}
              >
                <XCircle /> Reject
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

/* ----------------------------- Report dialog ----------------------------- */

function ReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [siteId, setSiteId] = useState('')
  const [milestoneId, setMilestoneId] = useState<string>(UNSET)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<SiteDTO[]>('/api/sites'),
  })
  const milestonesQuery = useQuery({
    queryKey: ['milestones', siteId],
    queryFn: () => api.get<MilestoneDTO[]>(`/api/milestones?siteId=${encodeURIComponent(siteId)}`),
    enabled: open && siteId !== '',
  })

  // Reset the milestone whenever the site changes.
  const handleSiteChange = (value: string) => {
    setSiteId(value)
    setMilestoneId(UNSET)
  }

  const report = useMutation({
    mutationFn: () => {
      const payload: {
        siteId: string
        title: string
        milestoneId?: string
        description?: string
        photoUrl?: string
      } = { siteId, title: title.trim() }
      if (milestoneId !== UNSET) payload.milestoneId = milestoneId
      const desc = description.trim()
      if (desc) payload.description = desc
      const photo = photoUrl.trim()
      if (photo) payload.photoUrl = photo
      return api.post<EvidenceRecord>('/api/evidence', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evidence'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: 'Evidence reported',
        description: 'Your report is in the queue — a supervisor will review it.',
      })
      setTitle('')
      setDescription('')
      setPhotoUrl('')
      setMilestoneId(UNSET)
      onOpenChange(false)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not report evidence', description: error.message }),
  })

  const sites = sitesQuery.data ?? []
  const milestones = milestonesQuery.data ?? []
  const titleValid = title.trim().length >= 3

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-stone-900">Report site evidence</DialogTitle>
          <DialogDescription>
            Reports go to the verification queue — a named supervisor reviews each one.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (siteId !== '' && titleValid) report.mutate()
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="evidence-site">Site</Label>
              <Select value={siteId} onValueChange={handleSiteChange}>
                <SelectTrigger id="evidence-site" className="h-11 w-full">
                  <SelectValue placeholder="Select site" />
                </SelectTrigger>
                <SelectContent>
                  {sites.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-stone-500">
                      No sites yet — create one first.
                    </div>
                  ) : (
                    sites.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="evidence-milestone">Milestone</Label>
              <Select
                value={milestoneId}
                onValueChange={setMilestoneId}
                disabled={siteId === ''}
              >
                <SelectTrigger id="evidence-milestone" className="h-11 w-full">
                  <SelectValue placeholder="None — site-wide report" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>None — site-wide report</SelectItem>
                  {milestonesQuery.isPending ? (
                    <div className="px-2 py-1.5 text-sm text-stone-500">Loading milestones…</div>
                  ) : milestones.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-stone-500">
                      No milestones for this site.
                    </div>
                  ) : (
                    milestones.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="evidence-title">Title</Label>
            <Input
              id="evidence-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Foundation trench complete"
              className="h-11"
              autoComplete="off"
              required
              minLength={3}
            />
            {!titleValid && title.length > 0 && (
              <p className="text-xs text-stone-500">Minimum 3 characters.</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="evidence-description">Description</Label>
            <Textarea
              id="evidence-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What was done, quantities, who was on site… (optional)"
              rows={3}
              className="resize-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evidence-photo">Photo link</Label>
            <Input
              id="evidence-photo"
              value={photoUrl}
              onChange={(e) => setPhotoUrl(e.target.value)}
              placeholder="https://... (optional link to photo)"
              className="h-11"
              autoComplete="off"
              inputMode="url"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11 border-stone-300 text-stone-700"
              onClick={() => onOpenChange(false)}
              disabled={report.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-11 bg-amber-500 text-stone-950 hover:bg-amber-600"
              disabled={report.isPending || siteId === '' || !titleValid}
            >
              {report.isPending && <Loader2 className="animate-spin" aria-hidden />} Submit report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
