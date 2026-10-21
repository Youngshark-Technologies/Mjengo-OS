'use client'

// MJG-009b — Workforce: workers roster, site assignments, daily attendance.

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  ClipboardList,
  Loader2,
  MapPin,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  UserPlus,
  Users,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import {
  ATTENDANCE_STATUS_VALUES,
  ASSIGNMENT_STATUS_VALUES,
  WORKER_TRADE_VALUES,
  formatMoney,
  type AssignmentDTO,
  type AssignmentStatus,
  type AttendanceDTO,
  type AttendanceStatus,
  type OrgMemberDTO,
  type SessionUser,
  type SiteDTO,
  type WorkerDTO,
  type WorkerTrade,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const UNSET = '__unset__'

function humanize(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ')
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })
}

function todayISO(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const assignmentStatusClass: Record<AssignmentStatus, string> = {
  ASSIGNED: 'border-stone-300 bg-stone-100 text-stone-700',
  ACTIVE: 'border-transparent bg-amber-500 text-stone-950',
  COMPLETED: 'border-emerald-300 bg-emerald-50 text-emerald-700',
}

const attendanceStatusClass: Record<AttendanceStatus, string> = {
  PRESENT: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  ABSENT: 'border-red-300 bg-red-50 text-red-700',
  HALF_DAY: 'border-amber-300 bg-amber-50 text-amber-800',
}

function TradeBadge({ trade }: { trade: WorkerTrade }) {
  return (
    <Badge variant="outline" className="border-stone-300 bg-stone-50 text-stone-600">
      {humanize(trade)}
    </Badge>
  )
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
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
          <p className="text-sm font-medium text-stone-900">Something went wrong</p>
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

export function WorkforceView() {
  const [tab, setTab] = useState('workers')

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-stone-900">Workforce</h2>
        <p className="mt-0.5 text-sm text-stone-500">
          Crew roster, site assignments and daily attendance.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="h-11 w-full sm:w-auto">
          <TabsTrigger value="workers">Workers</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="attendance">Attendance (today)</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>
        <TabsContent value="workers">
          <WorkersTab />
        </TabsContent>
        <TabsContent value="assignments">
          <AssignmentsTab />
        </TabsContent>
        <TabsContent value="attendance">
          <AttendanceTab onGoToAssignments={() => setTab('assignments')} />
        </TabsContent>
        <TabsContent value="team">
          <TeamTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ----------------------------- Workers ----------------------------- */

function WorkersTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [trade, setTrade] = useState<string>(UNSET)
  const [dailyRate, setDailyRate] = useState('')

  const workersQuery = useQuery({
    queryKey: ['workers'],
    queryFn: () => api.get<WorkerDTO[]>('/api/workers'),
  })

  const addWorker = useMutation({
    mutationFn: (payload: { name: string; phone?: string; trade?: WorkerTrade; dailyRate?: number }) =>
      api.post<WorkerDTO>('/api/workers', payload),
    onSuccess: (worker) => {
      queryClient.invalidateQueries({ queryKey: ['workers'] })
      toast({ title: 'Worker added', description: `${worker.name} joined the roster.` })
      setName('')
      setPhone('')
      setTrade(UNSET)
      setDailyRate('')
      setOpen(false)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not add worker', description: error.message }),
  })

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const payload: { name: string; phone?: string; trade?: WorkerTrade; dailyRate?: number } = {
      name: trimmed,
    }
    const trimmedPhone = phone.trim()
    if (trimmedPhone) payload.phone = trimmedPhone
    if (trade !== UNSET) payload.trade = trade as WorkerTrade
    const rate = Number(dailyRate)
    if (dailyRate.trim() !== '' && Number.isFinite(rate)) payload.dailyRate = rate
    addWorker.mutate(payload)
  }

  const workers = workersQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-stone-500">
          {workersQuery.isSuccess ? `${workers.length} worker${workers.length === 1 ? '' : 's'} on the roster` : 'Crew roster'}
        </p>
        <Button
          onClick={() => setOpen(true)}
          className="h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600 sm:w-auto"
        >
          <Plus /> Add worker
        </Button>
      </div>

      {workersQuery.isPending ? (
        <ListSkeleton />
      ) : workersQuery.isError ? (
        <ErrorState
          message={(workersQuery.error as Error | null)?.message}
          onRetry={() => workersQuery.refetch()}
        />
      ) : workers.length === 0 ? (
        <EmptyState
          title="No workers yet"
          description="Add your first crew member to start assigning them to sites."
          action={
            <Button
              onClick={() => setOpen(true)}
              className="h-11 bg-amber-500 text-stone-950 hover:bg-amber-600"
            >
              <Plus /> Add worker
            </Button>
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-stone-200 bg-white md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-stone-50 hover:bg-stone-50">
                  <TableHead className="text-stone-500">Name</TableHead>
                  <TableHead className="text-stone-500">Trade</TableHead>
                  <TableHead className="text-stone-500">Phone</TableHead>
                  <TableHead className="text-stone-500">Daily rate</TableHead>
                  <TableHead className="text-stone-500">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium text-stone-900">{w.name}</TableCell>
                    <TableCell>
                      <TradeBadge trade={w.trade} />
                    </TableCell>
                    <TableCell className="text-stone-600">{w.phone || '—'}</TableCell>
                    <TableCell className="text-stone-600">{formatMoney(w.dailyRate)}</TableCell>
                    <TableCell>
                      {w.active ? (
                        <Badge className="border-emerald-300 bg-emerald-50 text-emerald-700">Active</Badge>
                      ) : (
                        <Badge className="border-stone-300 bg-stone-100 text-stone-600">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {workers.map((w) => (
              <Card key={w.id} className="gap-2 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-stone-900">{w.name}</p>
                  {w.active ? (
                    <Badge className="border-emerald-300 bg-emerald-50 text-emerald-700">Active</Badge>
                  ) : (
                    <Badge className="border-stone-300 bg-stone-100 text-stone-600">Inactive</Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <TradeBadge trade={w.trade} />
                  <span className="text-sm text-stone-600">{formatMoney(w.dailyRate)} / day</span>
                </div>
                <p className="text-sm text-stone-500">{w.phone || 'No phone recorded'}</p>
              </Card>
            ))}
          </div>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900">Add worker</DialogTitle>
            <DialogDescription>
              Add a crew member to your organization roster.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="worker-name">Name</Label>
              <Input
                id="worker-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                className="h-11"
                autoComplete="off"
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="worker-phone">Phone</Label>
                <Input
                  id="worker-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 0722 000 000"
                  className="h-11"
                  autoComplete="off"
                  inputMode="tel"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="worker-rate">Daily rate (KES)</Label>
                <Input
                  id="worker-rate"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={dailyRate}
                  onChange={(e) => setDailyRate(e.target.value)}
                  placeholder="e.g. 1500"
                  className="h-11"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="worker-trade">Trade</Label>
              <Select value={trade} onValueChange={setTrade}>
                <SelectTrigger id="worker-trade" className="h-11 w-full">
                  <SelectValue placeholder="Select trade (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {WORKER_TRADE_VALUES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {humanize(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11 border-stone-300 text-stone-700"
                onClick={() => setOpen(false)}
                disabled={addWorker.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11 bg-amber-500 text-stone-950 hover:bg-amber-600"
                disabled={addWorker.isPending || name.trim() === ''}
              >
                {addWorker.isPending && <Loader2 className="animate-spin" aria-hidden />} Save worker
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* --------------------------- Assignments --------------------------- */

function AssignmentsTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [siteFilter, setSiteFilter] = useState('ALL')
  const [open, setOpen] = useState(false)
  const [workerId, setWorkerId] = useState('')
  const [assignSiteId, setAssignSiteId] = useState('')
  const [startDate, setStartDate] = useState('')

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<SiteDTO[]>('/api/sites'),
  })
  const workersQuery = useQuery({
    queryKey: ['workers'],
    queryFn: () => api.get<WorkerDTO[]>('/api/workers'),
  })
  const assignmentsQuery = useQuery({
    queryKey: ['assignments'],
    queryFn: () => api.get<AssignmentDTO[]>('/api/assignments'),
  })

  const filtered = useMemo(() => {
    const list = assignmentsQuery.data ?? []
    return siteFilter === 'ALL' ? list : list.filter((a) => a.siteId === siteFilter)
  }, [assignmentsQuery.data, siteFilter])

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AssignmentStatus }) =>
      api.patch<AssignmentDTO>(`/api/assignments/${id}`, { status }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] })
      queryClient.invalidateQueries({ queryKey: ['attendance'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: 'Assignment updated',
        description: `${humanize(variables.status)} — the attendance sheet reflects this immediately.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not update assignment', description: error.message }),
  })

  const assign = useMutation({
    mutationFn: () => {
      const payload: { workerId: string; siteId: string; startDate?: string } = {
        workerId,
        siteId: assignSiteId,
      }
      if (startDate.trim() !== '') payload.startDate = startDate
      return api.post<AssignmentDTO>('/api/assignments', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] })
      queryClient.invalidateQueries({ queryKey: ['attendance'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Worker assigned', description: 'The assignment now appears on the site roster.' })
      setWorkerId('')
      setAssignSiteId('')
      setStartDate('')
      setOpen(false)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not assign worker', description: error.message }),
  })

  const sites = sitesQuery.data ?? []
  const workers = workersQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Label htmlFor="assignment-site-filter" className="sr-only">
            Filter by site
          </Label>
          <Select value={siteFilter} onValueChange={setSiteFilter}>
            <SelectTrigger id="assignment-site-filter" className="h-11 w-full sm:w-60">
              <SelectValue placeholder="Filter by site" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All sites</SelectItem>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={() => setOpen(true)}
          className="h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600 sm:w-auto"
        >
          <Plus /> Assign worker
        </Button>
      </div>

      {assignmentsQuery.isPending ? (
        <ListSkeleton />
      ) : assignmentsQuery.isError ? (
        <ErrorState
          message={(assignmentsQuery.error as Error | null)?.message}
          onRetry={() => assignmentsQuery.refetch()}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No assignments"
          description={
            siteFilter === 'ALL'
              ? 'Assign a worker to a site to build your crew roster.'
              : 'No assignments at this site yet.'
          }
          action={
            <Button
              onClick={() => setOpen(true)}
              className="h-11 bg-amber-500 text-stone-950 hover:bg-amber-600"
            >
              <Plus /> Assign worker
            </Button>
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-stone-200 bg-white md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-stone-50 hover:bg-stone-50">
                  <TableHead className="text-stone-500">Worker</TableHead>
                  <TableHead className="text-stone-500">Trade</TableHead>
                  <TableHead className="text-stone-500">Site</TableHead>
                  <TableHead className="text-stone-500">Status</TableHead>
                  <TableHead className="text-stone-500">Start date</TableHead>
                  <TableHead className="w-16 text-stone-500">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium text-stone-900">{a.workerName}</TableCell>
                    <TableCell>
                      <TradeBadge trade={a.trade} />
                    </TableCell>
                    <TableCell className="text-stone-600">{a.siteName}</TableCell>
                    <TableCell>
                      <Badge className={assignmentStatusClass[a.status]}>{humanize(a.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-stone-600">{formatDate(a.startDate)}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            className="h-11 w-11 p-0 text-stone-500"
                            disabled={setStatus.isPending}
                          >
                            <span className="sr-only">Change assignment status</span>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Update status</DropdownMenuLabel>
                          {ASSIGNMENT_STATUS_VALUES.filter((s) => s !== a.status).map((s) => (
                            <DropdownMenuItem
                              key={s}
                              onClick={() => setStatus.mutate({ id: a.id, status: s })}
                            >
                              Mark {humanize(s).toLowerCase()}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {filtered.map((a) => (
              <Card key={a.id} className="gap-3 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-900">{a.workerName}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-stone-500">
                      <MapPin className="size-3" aria-hidden /> {a.siteName}
                    </p>
                  </div>
                  <Badge className={assignmentStatusClass[a.status]}>{humanize(a.status)}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                  <TradeBadge trade={a.trade} />
                  <span className="flex items-center gap-1">
                    <CalendarDays className="size-3" aria-hidden /> Started {formatDate(a.startDate)}
                  </span>
                </div>
                <div className="flex gap-2 border-t border-stone-100 pt-3">
                  {ASSIGNMENT_STATUS_VALUES.filter((s) => s !== a.status).map((s) => (
                    <Button
                      key={s}
                      variant="outline"
                      className="h-11 flex-1 border-stone-300 text-stone-700"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ id: a.id, status: s })}
                    >
                      Mark {humanize(s).toLowerCase()}
                    </Button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900">Assign worker</DialogTitle>
            <DialogDescription>Place a worker on a site to start tracking their work.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              assign.mutate()
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="assign-worker">Worker</Label>
              <Select value={workerId} onValueChange={setWorkerId}>
                <SelectTrigger id="assign-worker" className="h-11 w-full">
                  <SelectValue placeholder="Select worker" />
                </SelectTrigger>
                <SelectContent>
                  {workers.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-stone-500">No workers yet — add one first.</div>
                  ) : (
                    workers.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="assign-site">Site</Label>
              <Select value={assignSiteId} onValueChange={setAssignSiteId}>
                <SelectTrigger id="assign-site" className="h-11 w-full">
                  <SelectValue placeholder="Select site" />
                </SelectTrigger>
                <SelectContent>
                  {sites.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-stone-500">No sites yet — create one first.</div>
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
              <Label htmlFor="assign-start">Start date</Label>
              <Input
                id="assign-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-11"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11 border-stone-300 text-stone-700"
                onClick={() => setOpen(false)}
                disabled={assign.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11 bg-amber-500 text-stone-950 hover:bg-amber-600"
                disabled={assign.isPending || workerId === '' || assignSiteId === ''}
              >
                {assign.isPending && <Loader2 className="animate-spin" aria-hidden />} Assign
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ---------------------------- Attendance ---------------------------- */

interface DraftEntry {
  status: AttendanceStatus
  hours: string
}

interface AttendanceEntryInput {
  workerId: string
  status: AttendanceStatus
  hoursWorked?: number
}

function buildEntry(workerId: string, draft: DraftEntry): AttendanceEntryInput {
  const entry: AttendanceEntryInput = { workerId, status: draft.status }
  if (draft.status !== 'ABSENT') {
    const hours = Number(draft.hours)
    entry.hoursWorked = Number.isFinite(hours) ? hours : 8
  }
  return entry
}

function AttendanceTab({ onGoToAssignments }: { onGoToAssignments: () => void }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [siteOverride, setSiteOverride] = useState('')
  const [date, setDate] = useState(todayISO)
  const [edits, setEdits] = useState<Record<string, DraftEntry>>({})

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<SiteDTO[]>('/api/sites'),
  })
  const assignmentsQuery = useQuery({
    queryKey: ['assignments'],
    queryFn: () => api.get<AssignmentDTO[]>('/api/assignments'),
  })

  const sites = sitesQuery.data ?? []

  // '' means "auto": default to the first ACTIVE site (or the first site).
  const siteId = useMemo(() => {
    if (siteOverride !== '') return siteOverride
    if (sites.length === 0) return ''
    return (sites.find((s) => s.status === 'ACTIVE') ?? sites[0]).id
  }, [siteOverride, sites])

  const activeWorkers = useMemo(() => {
    const list = assignmentsQuery.data ?? []
    return siteId === '' ? [] : list.filter((a) => a.siteId === siteId && a.status === 'ACTIVE')
  }, [assignmentsQuery.data, siteId])

  const attendanceQuery = useQuery({
    queryKey: ['attendance', siteId, date],
    queryFn: () =>
      api.get<AttendanceDTO[]>(
        `/api/attendance?siteId=${encodeURIComponent(siteId)}&date=${encodeURIComponent(date)}`,
      ),
    enabled: siteId !== '' && date !== '',
  })

  const savedMap = useMemo(() => {
    const map = new Map<string, AttendanceDTO>()
    for (const record of attendanceQuery.data ?? []) {
      if (!map.has(record.workerId)) map.set(record.workerId, record)
    }
    return map
  }, [attendanceQuery.data])

  // Drafts are derived, not synced: explicit user edits win, then the saved
  // record, then the PRESENT / 8h default.
  const draftFor = useCallback(
    (workerId: string): DraftEntry => {
      const edit = edits[workerId]
      if (edit) return edit
      const saved = savedMap.get(workerId)
      return {
        status: saved?.status ?? 'PRESENT',
        hours: saved ? String(saved.hoursWorked) : '8',
      }
    },
    [edits, savedMap],
  )

  const updateDraft = useCallback(
    (workerId: string, patch: Partial<DraftEntry>) => {
      setEdits((prev) => ({
        ...prev,
        [workerId]: { ...draftFor(workerId), ...patch },
      }))
    },
    [draftFor],
  )

  const changedEntries = useMemo<AttendanceEntryInput[]>(() => {
    const entries: AttendanceEntryInput[] = []
    for (const a of activeWorkers) {
      const draft = draftFor(a.workerId)
      const saved = savedMap.get(a.workerId)
      if (!saved) {
        entries.push(buildEntry(a.workerId, draft))
        continue
      }
      if (draft.status !== saved.status) {
        entries.push(buildEntry(a.workerId, draft))
        continue
      }
      if (draft.status === 'ABSENT') continue
      const hours = Number(draft.hours)
      if (!Number.isFinite(hours) || hours !== saved.hoursWorked) {
        entries.push(buildEntry(a.workerId, draft))
      }
    }
    return entries
  }, [activeWorkers, draftFor, savedMap])

  const saveAttendance = useMutation({
    mutationFn: (entries: AttendanceEntryInput[]) =>
      api.post('/api/attendance', { siteId, date, entries }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: 'Attendance saved',
        description: `${changedEntries.length} record${changedEntries.length === 1 ? '' : 's'} for ${formatDate(date)}.`,
      })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Could not save attendance', description: error.message }),
  })

  const counts = useMemo(() => {
    const list = attendanceQuery.data ?? []
    return {
      present: list.filter((r) => r.status === 'PRESENT').length,
      absent: list.filter((r) => r.status === 'ABSENT').length,
      halfDay: list.filter((r) => r.status === 'HALF_DAY').length,
    }
  }, [attendanceQuery.data])

  const loading =
    sitesQuery.isPending || (siteId !== '' && (assignmentsQuery.isPending || attendanceQuery.isPending))
  const listError = assignmentsQuery.isError
    ? (assignmentsQuery.error as Error | null)?.message
    : attendanceQuery.isError
      ? (attendanceQuery.error as Error | null)?.message
      : undefined
  const retry = () => {
    if (assignmentsQuery.isError) assignmentsQuery.refetch()
    if (attendanceQuery.isError) attendanceQuery.refetch()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="w-full space-y-2 sm:w-64">
          <Label htmlFor="attendance-site">Site</Label>
          <Select value={siteId} onValueChange={setSiteOverride}>
            <SelectTrigger id="attendance-site" className="h-11 w-full">
              <SelectValue placeholder="Select site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full space-y-2 sm:w-44">
          <Label htmlFor="attendance-date">Date</Label>
          <Input
            id="attendance-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11"
          />
        </div>
        {attendanceQuery.isSuccess && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:pb-2.5">
            <Badge className="border-emerald-300 bg-emerald-50 text-emerald-700">
              Present {counts.present}
            </Badge>
            <Badge className="border-red-300 bg-red-50 text-red-700">Absent {counts.absent}</Badge>
            <Badge className="border-amber-300 bg-amber-50 text-amber-800">
              Half day {counts.halfDay}
            </Badge>
          </div>
        )}
      </div>

      {loading ? (
        <ListSkeleton />
      ) : siteId === '' ? (
        sites.length === 0 ? (
          <EmptyState
            title="No sites yet"
            description="Create a site first — attendance is recorded per site."
          />
        ) : (
          <EmptyState title="Select a site" description="Choose a site to record attendance for this date." />
        )
      ) : listError ? (
        <ErrorState message={listError} onRetry={retry} />
      ) : activeWorkers.length === 0 ? (
        <EmptyState
          title="No active assignments at this site"
          description="Assign workers to this site and mark them active to record their attendance."
          action={
            <Button
              variant="outline"
              onClick={onGoToAssignments}
              className="h-11 border-stone-300 text-stone-700"
            >
              <Users /> Go to assignments
            </Button>
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-stone-200 bg-white md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-stone-50 hover:bg-stone-50">
                  <TableHead className="text-stone-500">Worker</TableHead>
                  <TableHead className="text-stone-500">Trade</TableHead>
                  <TableHead className="text-stone-500">Status</TableHead>
                  <TableHead className="text-stone-500">Hours</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeWorkers.map((a) => {
                  const draft = draftFor(a.workerId)
                  if (!draft) return null
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium text-stone-900">{a.workerName}</TableCell>
                      <TableCell>
                        <TradeBadge trade={a.trade} />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={draft.status}
                          onValueChange={(v) => updateDraft(a.workerId, { status: v as AttendanceStatus })}
                        >
                          <SelectTrigger className="h-11 w-40" aria-label={`Status for ${a.workerName}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ATTENDANCE_STATUS_VALUES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {humanize(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          max={24}
                          step="any"
                          inputMode="decimal"
                          value={draft.hours}
                          disabled={draft.status === 'ABSENT'}
                          onChange={(e) => updateDraft(a.workerId, { hours: e.target.value })}
                          className="h-11 w-24"
                          aria-label={`Hours worked for ${a.workerName}`}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {activeWorkers.map((a) => {
              const draft = draftFor(a.workerId)
              if (!draft) return null
              return (
                <Card key={a.id} className="gap-3 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium text-stone-900">{a.workerName}</p>
                    <TradeBadge trade={a.trade} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={draft.status}
                      onValueChange={(v) => updateDraft(a.workerId, { status: v as AttendanceStatus })}
                    >
                      <SelectTrigger className="h-11 flex-1" aria-label={`Status for ${a.workerName}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ATTENDANCE_STATUS_VALUES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {humanize(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      max={24}
                      step="any"
                      inputMode="decimal"
                      value={draft.hours}
                      disabled={draft.status === 'ABSENT'}
                      onChange={(e) => updateDraft(a.workerId, { hours: e.target.value })}
                      className="h-11 w-20"
                      aria-label={`Hours worked for ${a.workerName}`}
                    />
                  </div>
                </Card>
              )
            })}
          </div>

          {/* MJG-017: the batch save is deliberate by design — the dirty state
              must be unmissable (amber emphasis + live announcement). */}
          <div className="sticky bottom-4 z-10">
            <div
              role="status"
              aria-live="polite"
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 backdrop-blur transition-colors ${
                changedEntries.length > 0
                  ? 'border-amber-300 bg-amber-50/95 shadow-lg shadow-amber-500/10'
                  : 'border-stone-200 bg-white/95 shadow-lg'
              }`}
            >
              <p
                className={`flex items-center gap-2 text-sm ${
                  changedEntries.length > 0 ? 'font-medium text-amber-900' : 'text-stone-600'
                }`}
              >
                <ClipboardList
                  className={`size-4 ${changedEntries.length > 0 ? 'text-amber-600' : 'text-stone-400'}`}
                  aria-hidden
                />
                {changedEntries.length === 0
                  ? 'All records saved for this date'
                  : `${changedEntries.length} change${changedEntries.length === 1 ? '' : 's'} ready — not saved yet`}
              </p>
              <Button
                onClick={() => saveAttendance.mutate(changedEntries)}
                disabled={saveAttendance.isPending || changedEntries.length === 0}
                className={`h-11 bg-amber-500 text-stone-950 hover:bg-amber-600 ${
                  changedEntries.length > 0 ? 'shadow-md shadow-amber-500/40' : ''
                }`}
              >
                {saveAttendance.isPending && <Loader2 className="animate-spin" aria-hidden />} Save
                attendance ({changedEntries.length})
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------- Team ------------------------------- */

const ROLE_BADGE: Record<string, string> = {
  OWNER: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  SUPERVISOR: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  WORKER: 'bg-stone-500/10 text-stone-600 border-stone-500/30',
}

function TeamTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'SUPERVISOR' | 'WORKER'>('SUPERVISOR')

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<SessionUser>('/api/auth/me'),
    staleTime: 60_000,
  })
  const members = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<OrgMemberDTO[]>('/api/users'),
  })

  const isOwner = me.data?.role === 'OWNER'

  const addMember = useMutation({
    mutationFn: () =>
      api.post<OrgMemberDTO>('/api/users', { name, email, password, role }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setOpen(false)
      setName(''); setEmail(''); setPassword(''); setRole('SUPERVISOR')
      toast({ title: 'Member added', description: `${created.name} can sign in with the credentials you set.` })
    },
    onError: (e: Error) =>
      toast({ title: 'Could not add member', description: e.message, variant: 'destructive' }),
  })

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-3 border-stone-200 bg-stone-50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-amber-500/10 p-2">
            <ShieldCheck className="h-4 w-4 text-amber-600" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium text-stone-900">Roles keep accountability human.</p>
            <p className="text-xs text-stone-500">
              Supervisors verify evidence and review deliveries. Workers report from the field.
              Only the owner approves payments.
            </p>
          </div>
        </div>
        {isOwner ? (
          <Button className="h-11 shrink-0 bg-amber-500 text-stone-950 hover:bg-amber-600" onClick={() => setOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" /> Add member
          </Button>
        ) : (
          <span className="text-xs text-stone-400 sm:self-center">Only the owner can add members</span>
        )}
      </Card>

      {members.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : members.isError ? (
        <Card className="flex flex-col items-center gap-3 border-stone-200 p-8 text-center">
          <TriangleAlert className="h-8 w-8 text-stone-400" aria-hidden="true" />
          <p className="text-sm text-stone-600">{(members.error as Error).message}</p>
          <Button variant="outline" className="h-11" onClick={() => members.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Retry
          </Button>
        </Card>
      ) : (members.data ?? []).length === 0 ? (
        <Card className="border-dashed border-stone-300 p-8 text-center text-sm text-stone-500">
          No team members yet.
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-stone-200 bg-white md:block">
            <Table>
              <TableHeader>
                <TableRow className="border-stone-200">
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(members.data ?? []).map((m) => (
                  <TableRow key={m.id} className="border-stone-100">
                    <TableCell className="font-medium text-stone-900">{m.name}</TableCell>
                    <TableCell className="text-stone-500">{m.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={ROLE_BADGE[m.role] ?? ''}>{m.role}</Badge>
                    </TableCell>
                    <TableCell className="text-stone-500">
                      {new Date(m.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {/* Mobile cards */}
          <div className="space-y-2 md:hidden">
            {(members.data ?? []).map((m) => (
              <Card key={m.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900">{m.name}</p>
                  <p className="truncate text-xs text-stone-500">{m.email}</p>
                </div>
                <Badge variant="outline" className={ROLE_BADGE[m.role] ?? ''}>{m.role}</Badge>
              </Card>
            ))}
          </div>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
            <DialogDescription>
              Create an account for a supervisor or worker in your organization. They sign in with the
              email and password you set here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="member-name">Full name</Label>
              <Input id="member-name" className="h-11" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amina Supervisor" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="member-email">Email</Label>
              <Input id="member-email" className="h-11" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="supervisor@company.co.ke" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="member-password">Temporary password</Label>
              <Input id="member-password" className="h-11" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as 'SUPERVISOR' | 'WORKER')}>
                <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SUPERVISOR">Supervisor — verifies evidence and deliveries</SelectItem>
                  <SelectItem value="WORKER">Worker — reports from the field</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600"
              disabled={addMember.isPending || !name.trim() || !email.trim() || password.length < 8}
              onClick={() => addMember.mutate()}
            >
              {addMember.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Create member account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
