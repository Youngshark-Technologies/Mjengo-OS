// MjengoOS shared domain types & vocabulary.
// SQLite has no Prisma enums — these unions are enforced by zod at the API layer.

export type Role = 'OWNER' | 'SUPERVISOR' | 'WORKER'
export type SiteStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED'
export type MilestoneStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'
export type MaterialUnit = 'BAG' | 'TON' | 'KG' | 'M3' | 'L' | 'PCS' | 'ROLL' | 'PACK'
export type MovementType = 'IN' | 'OUT' | 'ADJUST'
export type POStatus = 'DRAFT' | 'SENT' | 'RECEIVED' | 'CANCELLED'
export type DeliveryStatus = 'PENDING' | 'VERIFIED' | 'REJECTED'
export type WorkerTrade =
  | 'MASON' | 'CARPENTER' | 'STEEL_FIXER' | 'ELECTRICIAN' | 'PLUMBER'
  | 'PAINTER' | 'WELDER' | 'FOREMAN' | 'LABORER' | 'OTHER'
export type AssignmentStatus = 'ASSIGNED' | 'ACTIVE' | 'COMPLETED'
export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY'
export type EvidenceStatus = 'REPORTED' | 'VERIFIED' | 'REJECTED'
export type PaymentStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REJECTED'
export type PaymentCategory = 'MATERIAL' | 'LABOUR' | 'EQUIPMENT' | 'OTHER'
export type PaymentMethod = 'MPESA' | 'BANK' | 'CASH' | 'CHEQUE'

export const ROLE_VALUES: Role[] = ['OWNER', 'SUPERVISOR', 'WORKER']
export const SITE_STATUS_VALUES: SiteStatus[] = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED']
export const MILESTONE_STATUS_VALUES: MilestoneStatus[] = ['PENDING', 'IN_PROGRESS', 'COMPLETED']
export const MATERIAL_UNIT_VALUES: MaterialUnit[] = ['BAG', 'TON', 'KG', 'M3', 'L', 'PCS', 'ROLL', 'PACK']
export const MOVEMENT_TYPE_VALUES: MovementType[] = ['IN', 'OUT', 'ADJUST']
export const PO_STATUS_VALUES: POStatus[] = ['DRAFT', 'SENT', 'RECEIVED', 'CANCELLED']
export const DELIVERY_STATUS_VALUES: DeliveryStatus[] = ['PENDING', 'VERIFIED', 'REJECTED']
export const WORKER_TRADE_VALUES: WorkerTrade[] = [
  'MASON', 'CARPENTER', 'STEEL_FIXER', 'ELECTRICIAN', 'PLUMBER',
  'PAINTER', 'WELDER', 'FOREMAN', 'LABORER', 'OTHER',
]
export const ASSIGNMENT_STATUS_VALUES: AssignmentStatus[] = ['ASSIGNED', 'ACTIVE', 'COMPLETED']
export const ATTENDANCE_STATUS_VALUES: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'HALF_DAY']
export const EVIDENCE_STATUS_VALUES: EvidenceStatus[] = ['REPORTED', 'VERIFIED', 'REJECTED']
export const PAYMENT_STATUS_VALUES: PaymentStatus[] = ['PENDING', 'APPROVED', 'PAID', 'REJECTED']
export const PAYMENT_CATEGORY_VALUES: PaymentCategory[] = ['MATERIAL', 'LABOUR', 'EQUIPMENT', 'OTHER']
export const PAYMENT_METHOD_VALUES: PaymentMethod[] = ['MPESA', 'BANK', 'CASH', 'CHEQUE']

export interface SessionUser {
  id: string
  name: string
  email: string
  role: Role
  organizationId: string
  organizationName: string
}

export interface SiteDTO {
  id: string
  name: string
  location: string
  status: SiteStatus
  startDate: string | null
  targetEndDate: string | null
  createdAt: string
}

export interface MaterialDTO {
  id: string
  name: string
  unit: MaterialUnit
  category: string
  unitCost: number
}

export interface StockLevelDTO {
  id: string
  siteId: string
  siteName: string
  materialId: string
  materialName: string
  unit: MaterialUnit
  unitCost: number
  quantity: number
  updatedAt: string
}

export interface StockMovementDTO {
  id: string
  siteId: string
  siteName: string
  materialName: string
  type: MovementType
  quantity: number
  reason: string
  createdAt: string
}

export interface SupplierDTO {
  id: string
  name: string
  phone: string | null
  email: string | null
  category: string
}

export interface POItemInput { materialId: string; quantity: number; unitCost: number }
export interface POItemDTO extends POItemInput { materialName: string; unit: MaterialUnit }

export interface PurchaseOrderDTO {
  id: string
  siteId: string
  siteName: string
  supplierId: string
  supplierName: string
  status: POStatus
  orderDate: string
  expectedDate: string | null
  notes: string
  total: number
  items: POItemDTO[]
}

export interface DeliveryItemDTO {
  materialId: string
  materialName: string
  unit: MaterialUnit
  quantityDelivered: number
  quantityAccepted: number
}

export interface DeliveryDTO {
  id: string
  siteId: string
  siteName: string
  purchaseOrderId: string | null
  supplierName: string | null
  status: DeliveryStatus
  deliveredAt: string
  verifiedByName: string | null
  verifiedAt: string | null
  notes: string
  items: DeliveryItemDTO[]
}

export interface WorkerDTO {
  id: string
  name: string
  phone: string | null
  trade: WorkerTrade
  dailyRate: number
  active: boolean
}

export interface AssignmentDTO {
  id: string
  workerId: string
  workerName: string
  trade: WorkerTrade
  siteId: string
  siteName: string
  status: AssignmentStatus
  startDate: string
  endDate: string | null
}

export interface AttendanceDTO {
  id: string
  workerId: string
  workerName: string
  siteId: string
  siteName: string
  date: string
  status: AttendanceStatus
  hoursWorked: number
}

export interface MilestoneDTO {
  id: string
  siteId: string
  siteName: string
  name: string
  status: MilestoneStatus
  dueDate: string | null
  order: number
}

export interface EvidenceDTO {
  id: string
  siteId: string
  siteName: string
  milestoneId: string | null
  milestoneName: string | null
  title: string
  description: string
  photoUrl: string | null
  status: EvidenceStatus
  reportedById: string
  reportedByName: string
  verifiedById: string | null
  verifiedByName: string | null
  verifiedAt: string | null
  createdAt: string
}

export interface PaymentDTO {
  id: string
  siteId: string
  siteName: string
  purchaseOrderId: string | null
  milestoneId: string | null
  milestoneName: string | null
  category: PaymentCategory
  method: PaymentMethod
  amount: number
  status: PaymentStatus
  reference: string
  notes: string
  recordedByName: string
  approvedByName: string | null
  approvedAt: string | null
  paidAt: string | null
  createdAt: string
}

export interface DashboardData {
  metrics: {
    activeSites: number
    totalSites: number
    stockValue: number
    pendingDeliveries: number
    evidenceAwaiting: number
    paymentsAwaiting: number
    workforceToday: number
    monthlySpend: number
  }
  sites: {
    id: string
    name: string
    status: SiteStatus
    progress: number
    milestonesTotal: number
    milestonesCompleted: number
  }[]
  recent: {
    id: string
    kind: 'EVIDENCE' | 'DELIVERY' | 'PAYMENT' | 'STOCK' | 'SITE'
    title: string
    meta: string
    at: string
  }[]
}

export interface OrgMemberDTO {
  id: string
  name: string
  email: string
  role: Role
  createdAt: string
}

export function formatMoney(amount: number): string {
  return `KES ${amount.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`
}
