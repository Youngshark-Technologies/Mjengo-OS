'use client'

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow } from 'date-fns'
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  MapPin,
  Plus,
  RefreshCw,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { SITE_STATUS_VALUES, type SiteDTO, type SiteStatus } from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
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

const SITE_STATUS_STYLES: Record<SiteStatus, string> = {
  PLANNING: 'bg-stone-200/70 text-stone-700',
  ACTIVE: 'bg-amber-500/15 text-amber-700',
  ON_HOLD: 'bg-orange-500/15 text-orange-700',
  COMPLETED: 'bg-emerald-500/15 text-emerald-700',
}

const SITE_STATUS_LABELS: Record<SiteStatus, string> = {
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
}

interface NewSiteForm {
  name: string
  location: string
  status: SiteStatus
  startDate: string
  targetEndDate: string
}

const EMPTY_FORM: NewSiteForm = {
  name: '',
  location: '',
  status: 'PLANNING',
  startDate: '',
  targetEndDate: '',
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Not set'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Not set'
  return format(date, 'd MMM yyyy')
}

function timeAgo(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return formatDistanceToNow(date, { addSuffix: true })
}

function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <Badge variant="outline" className={cn('border-transparent', SITE_STATUS_STYLES[status])}>
      {SITE_STATUS_LABELS[status]}
    </Badge>
  )
}

export function SitesView() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<NewSiteForm>(EMPTY_FORM)

  const { data: sites, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<SiteDTO[]>('/api/sites'),
  })

  const createSite = useMutation({
    mutationFn: (body: {
      name: string
      location: string
      status: SiteStatus
      startDate: string | null
      targetEndDate: string | null
    }) => api.post<SiteDTO>('/api/sites', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sites'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Site created' })
      setForm(EMPTY_FORM)
      setDialogOpen(false)
    },
    onError: (e: Error) =>
      toast({ title: 'Could not create site', description: e.message, variant: 'destructive' }),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SiteStatus }) =>
      api.patch<SiteDTO>(`/api/sites/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sites'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Status updated' })
    },
    onError: (e: Error) =>
      toast({ title: 'Could not update status', description: e.message, variant: 'destructive' }),
  })

  const submitNewSite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (form.name.trim() === '' || form.location.trim() === '') return
    createSite.mutate({
      name: form.name.trim(),
      location: form.location.trim(),
      status: form.status,
      startDate: form.startDate || null,
      targetEndDate: form.targetEndDate || null,
    })
  }

  const list = sites ?? []

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-500">
          {isLoading
            ? 'Loading sites…'
            : `${list.length} ${list.length === 1 ? 'site' : 'sites'}`}
        </p>
        <Button
          className="h-11 bg-amber-600 text-white hover:bg-amber-500"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-4" />
          New site
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-red-500/10">
            <AlertTriangle className="size-5 text-red-600" />
          </div>
          <div className="space-y-1">
            <p className="font-medium text-stone-900">Could not load sites</p>
            <p className="mx-auto max-w-md text-sm text-stone-500">{error.message}</p>
          </div>
          <Button variant="outline" className="h-11" onClick={() => refetch()}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </Card>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
            <Building2 className="size-6 text-amber-600" />
          </div>
          <div className="space-y-1">
            <p className="font-medium text-stone-900">No sites yet</p>
            <p className="mx-auto max-w-sm text-sm text-stone-500">
              Sites are where materials, workforce and evidence come together. Register your first
              construction site to get started.
            </p>
          </div>
          <Button
            className="h-11 bg-amber-600 text-white hover:bg-amber-500"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-4" />
            New site
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((site) => (
            <Card key={site.id} className="px-4 py-4 md:px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-medium text-stone-900">{site.name}</h3>
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-stone-500">
                    <MapPin className="size-3.5 shrink-0" />
                    <span className="truncate">{site.location}</span>
                  </p>
                </div>
                <SiteStatusBadge status={site.status} />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" />
                  Start: {formatDate(site.startDate)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" />
                  Target end: {formatDate(site.targetEndDate)}
                </span>
                <span>Created {timeAgo(site.createdAt)}</span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-100 pt-3">
                <span className="text-xs font-medium uppercase tracking-wide text-stone-400">
                  Status
                </span>
                <Select
                  value={site.status}
                  onValueChange={(v) => setStatus.mutate({ id: site.id, status: v as SiteStatus })}
                >
                  <SelectTrigger
                    className="h-11 w-40"
                    disabled={setStatus.isPending}
                    aria-label={`Change status of ${site.name}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SITE_STATUS_VALUES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {SITE_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* New site dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New site</DialogTitle>
            <DialogDescription>
              Register a construction site to track materials, workforce and evidence.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submitNewSite}>
            <div className="grid gap-2">
              <Label htmlFor="site-name">Name *</Label>
              <Input
                id="site-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Riverside Apartments Block A"
                autoFocus
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="site-location">Location *</Label>
              <Input
                id="site-location"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="e.g. Kilimani, Nairobi"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="site-status">Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v as SiteStatus }))}
              >
                <SelectTrigger id="site-status" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SITE_STATUS_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SITE_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="site-start">Start date</Label>
                <Input
                  id="site-start"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="site-end">Target end date</Label>
                <Input
                  id="site-end"
                  type="date"
                  value={form.targetEndDate}
                  onChange={(e) => setForm((f) => ({ ...f, targetEndDate: e.target.value }))}
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11 bg-amber-600 text-white hover:bg-amber-500"
                disabled={
                  createSite.isPending || form.name.trim() === '' || form.location.trim() === ''
                }
              >
                {createSite.isPending ? 'Creating…' : 'Create site'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
