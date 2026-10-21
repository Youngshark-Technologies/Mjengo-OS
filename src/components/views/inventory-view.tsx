'use client'

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import {
  AlertTriangle,
  Building2,
  PackageOpen,
  PackagePlus,
  Plus,
  RefreshCw,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { useAppStore } from '@/lib/store'
import {
  MATERIAL_UNIT_VALUES,
  MOVEMENT_TYPE_VALUES,
  formatMoney,
  type MaterialDTO,
  type MaterialUnit,
  type MovementType,
  type SiteDTO,
  type StockLevelDTO,
  type StockMovementDTO,
} from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const MOVEMENT_HELP: Record<MovementType, string> = {
  IN: 'Materials received on site. Increases stock on hand.',
  OUT: 'Materials issued to work. Decreases stock on hand.',
  ADJUST: 'Correction after a physical count or damage. Use a negative quantity to reduce.',
}

const MOVEMENT_BADGE: Record<MovementType, string> = {
  IN: 'bg-emerald-500/15 text-emerald-700',
  OUT: 'bg-red-500/15 text-red-700',
  ADJUST: 'bg-amber-500/15 text-amber-700',
}

interface MovementForm {
  type: MovementType
  materialId: string
  quantity: string
  reason: string
}

const EMPTY_MOVEMENT: MovementForm = { type: 'IN', materialId: '', quantity: '', reason: '' }

function timeAgo(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return formatDistanceToNow(date, { addSuffix: true })
}

function quantityText(level: StockLevelDTO): string {
  return `${level.quantity} ${level.unit}`
}

export function InventoryView() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [selectedSiteId, setSelectedSiteId] = useState<string>('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [materialDialogOpen, setMaterialDialogOpen] = useState(false)
  const [form, setForm] = useState<MovementForm>(EMPTY_MOVEMENT)

  const sitesQ = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<SiteDTO[]>('/api/sites'),
  })

  const materialsQ = useQuery({
    queryKey: ['materials'],
    queryFn: () => api.get<MaterialDTO[]>('/api/materials'),
  })

  const sites = sitesQ.data ?? []
  const siteId = selectedSiteId || sites[0]?.id || ''
  const activeSite = sites.find((s) => s.id === siteId)

  const inventoryQ = useQuery({
    queryKey: ['inventory', siteId],
    queryFn: () => api.get<StockLevelDTO[]>(`/api/inventory?siteId=${siteId}`),
    enabled: siteId !== '',
  })

  const movementsQ = useQuery({
    queryKey: ['movements', siteId],
    queryFn: () => api.get<StockMovementDTO[]>(`/api/inventory/movements?siteId=${siteId}`),
    enabled: siteId !== '',
  })

  const recordMovement = useMutation({
    mutationFn: (body: {
      siteId: string
      materialId: string
      type: MovementType
      quantity: number
      reason: string
    }) => api.post<StockMovementDTO>('/api/inventory/movements', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['movements'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Movement recorded' })
      setForm(EMPTY_MOVEMENT)
      setDialogOpen(false)
    },
    onError: (e: Error) =>
      toast({ title: 'Could not record movement', description: e.message, variant: 'destructive' }),
  })

  const parsedQuantity = Number(form.quantity)
  const canSubmitMovement =
    siteId !== '' &&
    form.materialId !== '' &&
    form.quantity.trim() !== '' &&
    Number.isFinite(parsedQuantity) &&
    form.reason.trim() !== '' &&
    !recordMovement.isPending

  const submitMovement = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canSubmitMovement) return
    recordMovement.mutate({
      siteId,
      materialId: form.materialId,
      type: form.type,
      quantity: parsedQuantity,
      reason: form.reason.trim(),
    })
  }

  const stock = inventoryQ.data ?? []
  const movements = movementsQ.data ?? []

  // No sites at all → inventory cannot be tracked.
  if (!sitesQ.isLoading && !sitesQ.isError && sites.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
          <Building2 className="size-6 text-amber-600" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-stone-900">No sites yet</p>
          <p className="mx-auto max-w-sm text-sm text-stone-500">
            Inventory is tracked per site. Create your first site to start recording stock.
          </p>
        </div>
        <Button
          className="h-11 bg-amber-600 text-white hover:bg-amber-500"
          onClick={() => useAppStore.getState().setView('sites')}
        >
          <Plus className="size-4" />
          Go to sites
        </Button>
      </Card>
    )
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Site selector + record movement */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:w-64">
          <Select value={siteId || undefined} onValueChange={setSelectedSiteId}>
            <SelectTrigger className="h-11 w-full" aria-label="Select site">
              <SelectValue
                placeholder={sitesQ.isLoading ? 'Loading sites…' : 'Select a site'}
              />
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
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            className="h-11 bg-amber-600 text-white hover:bg-amber-500"
            onClick={() => setMaterialDialogOpen(true)}
          >
            <Plus className="size-4" />
            Add material
          </Button>
          <Button
            className="h-11 bg-amber-600 text-white hover:bg-amber-500"
            onClick={() => setDialogOpen(true)}
            disabled={siteId === ''}
          >
            <PackagePlus className="size-4" />
            Record movement
          </Button>
        </div>
      </div>

      {sitesQ.isError ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-red-500/10">
            <AlertTriangle className="size-5 text-red-600" />
          </div>
          <div className="space-y-1">
            <p className="font-medium text-stone-900">Could not load sites</p>
            <p className="mx-auto max-w-md text-sm text-stone-500">{sitesQ.error.message}</p>
          </div>
          <Button variant="outline" className="h-11" onClick={() => sitesQ.refetch()}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Stock levels */}
          <div className="space-y-4 lg:col-span-2">
            {sitesQ.isLoading || inventoryQ.isLoading ? (
              <div className="space-y-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-xl" />
                ))}
              </div>
            ) : inventoryQ.isError ? (
              <Card className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex size-11 items-center justify-center rounded-full bg-red-500/10">
                  <AlertTriangle className="size-5 text-red-600" />
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-stone-900">Could not load stock levels</p>
                  <p className="mx-auto max-w-md text-sm text-stone-500">
                    {inventoryQ.error.message}
                  </p>
                </div>
                <Button variant="outline" className="h-11" onClick={() => inventoryQ.refetch()}>
                  <RefreshCw className="size-4" />
                  Retry
                </Button>
              </Card>
            ) : stock.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 py-14 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
                  <PackageOpen className="size-6 text-amber-600" />
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-stone-900">
                    No stock on {activeSite?.name ?? 'this site'} yet
                  </p>
                  <p className="mx-auto max-w-sm text-sm text-stone-500">
                    Record an IN movement when materials arrive to start tracking stock levels and
                    value.
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="h-11 border-amber-500/50 text-amber-700 hover:bg-amber-500/10"
                  onClick={() => setDialogOpen(true)}
                >
                  <PackagePlus className="size-4" />
                  Record first movement
                </Button>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Stock on hand</CardTitle>
                  <CardDescription>{activeSite?.name}</CardDescription>
                </CardHeader>
                <CardContent>
                  {/* Desktop table */}
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Material</TableHead>
                          <TableHead>On hand</TableHead>
                          <TableHead>Stock value</TableHead>
                          <TableHead className="text-right">Updated</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stock.map((level) => (
                          <TableRow key={level.id}>
                            <TableCell className="font-medium text-stone-900">
                              {level.materialName}
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {quantityText(level)}
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {formatMoney(level.quantity * level.unitCost)}
                            </TableCell>
                            <TableCell className="text-right text-stone-500">
                              {timeAgo(level.updatedAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {/* Mobile stacked cards */}
                  <div className="divide-y divide-stone-100 md:hidden">
                    {stock.map((level) => (
                      <div key={level.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-stone-900">
                            {level.materialName}
                          </p>
                          <p className="text-xs text-stone-500">
                            Updated {timeAgo(level.updatedAt)}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold tabular-nums text-stone-900">
                            {quantityText(level)}
                          </p>
                          <p className="text-xs tabular-nums text-stone-500">
                            {formatMoney(level.quantity * level.unitCost)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Recent movements */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent movements</CardTitle>
              <CardDescription>Latest stock activity on this site</CardDescription>
            </CardHeader>
            <CardContent>
              {movementsQ.isLoading || siteId === '' ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 rounded-lg" />
                  ))}
                </div>
              ) : movementsQ.isError ? (
                <div className="space-y-2 text-sm">
                  <p className="font-medium text-stone-900">Could not load movements</p>
                  <p className="text-stone-500">{movementsQ.error.message}</p>
                  <Button variant="outline" className="h-11" onClick={() => movementsQ.refetch()}>
                    <RefreshCw className="size-4" />
                    Retry
                  </Button>
                </div>
              ) : movements.length === 0 ? (
                <p className="py-2 text-sm text-stone-500">
                  No movements recorded for this site yet.
                </p>
              ) : (
                <ul className="divide-y divide-stone-100">
                  {movements.map((m) => (
                    <li key={m.id} className="flex items-start gap-2.5 py-3 first:pt-0 last:pb-0">
                      <Badge
                        variant="outline"
                        className={cn('mt-0.5 shrink-0 border-transparent', MOVEMENT_BADGE[m.type])}
                      >
                        {m.type}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-stone-900">
                          {m.materialName}
                          <span className="ml-1 tabular-nums text-stone-500">
                            {m.type === 'IN' ? '+' : m.type === 'OUT' ? '-' : ''}
                            {m.quantity}
                          </span>
                        </p>
                        <p className="truncate text-xs text-stone-500">
                          {m.reason !== '' ? m.reason : 'No reason given'}
                        </p>
                      </div>
                      <time
                        dateTime={m.createdAt}
                        className="shrink-0 text-xs text-stone-400"
                        title={new Date(m.createdAt).toLocaleString()}
                      >
                        {timeAgo(m.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Record movement dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record movement</DialogTitle>
            <DialogDescription>
              Log material stock changes for {activeSite?.name ?? 'this site'}.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submitMovement}>
            <div className="grid gap-2">
              <Label htmlFor="movement-type">Type</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as MovementType }))}
              >
                <SelectTrigger id="movement-type" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MOVEMENT_TYPE_VALUES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t === 'IN' ? 'IN — stock received' : t === 'OUT' ? 'OUT — issued to work' : 'ADJUST — count correction'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-stone-500">{MOVEMENT_HELP[form.type]}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="movement-material">Material *</Label>
              <Select
                value={form.materialId || undefined}
                onValueChange={(v) => setForm((f) => ({ ...f, materialId: v }))}
              >
                <SelectTrigger id="movement-material" className="h-11 w-full">
                  <SelectValue
                    placeholder={materialsQ.isLoading ? 'Loading materials…' : 'Select a material'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(materialsQ.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} ({m.unit})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {materialsQ.isError ? (
                <p className="text-xs text-red-600">
                  Could not load materials. {materialsQ.error.message}
                </p>
              ) : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="movement-quantity">Quantity *</Label>
              <Input
                id="movement-quantity"
                type="number"
                step="any"
                value={form.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                placeholder="e.g. 20"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="movement-reason">Reason *</Label>
              <Input
                id="movement-reason"
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder={
                  form.type === 'IN'
                    ? 'e.g. Delivered by supplier'
                    : form.type === 'OUT'
                      ? 'e.g. Issued to foundation works'
                      : 'e.g. Count correction after stocktake'
                }
                required
              />
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
                disabled={!canSubmitMovement}
              >
                {recordMovement.isPending ? 'Saving…' : 'Record movement'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add material dialog */}
      <AddMaterialDialog open={materialDialogOpen} onOpenChange={setMaterialDialogOpen} />
    </div>
  )
}

/* ------------------------- Add material dialog ------------------------- */

function AddMaterialDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [unit, setUnit] = useState<MaterialUnit>('BAG')
  const [category, setCategory] = useState('GENERAL')
  const [unitCost, setUnitCost] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api.post<MaterialDTO>('/api/materials', {
        name: name.trim(),
        unit,
        category: category.trim() || 'GENERAL',
        unitCost: unitCost === '' ? 0 : Number(unitCost),
      }),
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ['materials'] })
      onOpenChange(false)
      setName(''); setUnit('BAG'); setCategory('GENERAL'); setUnitCost('')
      toast({ title: 'Material added', description: `${m.name} is ready to receive stock.` })
    },
    onError: (e: Error) =>
      toast({ title: 'Could not add material', description: e.message, variant: 'destructive' }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add material</DialogTitle>
          <DialogDescription>
            Catalogue an item your sites buy, store and issue — with its unit and reference cost.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="material-name">Name</Label>
            <Input id="material-name" className="h-11" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cement (50kg)" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="material-unit">Unit</Label>
              <Select value={unit} onValueChange={(v) => setUnit(v as MaterialUnit)}>
                <SelectTrigger id="material-unit" className="h-11 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MATERIAL_UNIT_VALUES.map((u) => (
                    <SelectItem key={u} value={u}>{u}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="material-cost">Unit cost (KES)</Label>
              <Input id="material-cost" className="h-11" type="number" min="0" step="any" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="e.g. 700" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="material-category">Category</Label>
            <Input id="material-category" className="h-11" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="GENERAL, CEMENT, STEEL…" />
          </div>
          <Button
            type="submit"
            className="h-11 bg-amber-600 text-white hover:bg-amber-500"
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? 'Saving…' : 'Add material'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
